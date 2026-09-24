"""
vector_store_v2.py — RAG PHASE 2
Implements Daily Hot RAM Cache + Historical mmap Disk Cache.
"""

import json
import logging
import os
import sqlite3
import threading
import glob
import re
from datetime import datetime, timezone, date
from typing import List, Dict, Any, Optional, Tuple, Set

import numpy as np
import psutil
from pymongo import MongoClient, UpdateOne, ASCENDING, DeleteOne
from pymongo.collection import Collection

logger = logging.getLogger(__name__)

CACHE_DIR = os.path.join(os.path.dirname(__file__), ".vector_cache")
HOT_CACHE_MAX_ITEMS = int(os.getenv("HOT_CACHE_MAX_ITEMS", "500000"))
HOT_CACHE_MAX_MEMORY_MB = float(os.getenv("HOT_CACHE_MAX_MEMORY_MB", "1500.0"))
_EMBED_DIM = int(os.getenv("EMBED_DIM", "768"))
_INITIAL_CAPACITY = 10000

def _get_today() -> str:
    """Returns the current local calendar date string (YYYY-MM-DD)."""
    return datetime.now().strftime("%Y-%m-%d")

def _dt_to_date_str(dt: Any) -> str:
    if isinstance(dt, datetime):
        return dt.strftime("%Y-%m-%d")
    return ""

class VectorStore:
    def __init__(self, uri: str, db_name: str, collection_name: str = "vector_embeddings", cache_dir=CACHE_DIR):
        self.uri = uri
        self.db_name = db_name
        self.collection_name = collection_name
        self.cache_dir = cache_dir
        
        self._client: Optional[MongoClient] = None
        self._collection: Optional[Collection] = None
        
        self._lock = threading.RLock()
        
        # Hot Cache (Today) - Preallocated bounds
        self._hot_date: str = ""
        self._hot_mat: Optional[np.ndarray] = None
        self._hot_count: int = 0
        self._hot_capacity: int = 0
        
        self._hot_texts: List[str] = []
        self._hot_metas: List[Dict] = []
        self._hot_chunk_ids: Dict[str, int] = {}
        self._hot_overflow = False

    # -- connection ----------------------------------------------------------

    def connect(self) -> Collection:
        if self._collection is not None:
            return self._collection
        self._client = MongoClient(self.uri)
        db = self._client[self.db_name]
        self._collection = db[self.collection_name]
        return self._collection

    def close(self):
        if self._client:
            self._client.close()
            self._client = None
            self._collection = None

    def _get_rss_mb(self) -> float:
        return psutil.Process(os.getpid()).memory_info().rss / 1024 / 1024

    def _check_memory_bounds(self):
        """Transition to OVERFLOW if RSS or item count exceeds safe limits."""
        if self._hot_overflow:
            return True
            
        if self._hot_count >= HOT_CACHE_MAX_ITEMS:
            logger.warning("Hot cache reached %d max items. Transitioning to OVERFLOW.", self._hot_count)
            self._hot_overflow = True
            return True
            
        rss = self._get_rss_mb()
        if rss >= HOT_CACHE_MAX_MEMORY_MB:
            logger.warning("Process RSS (%.2f MB) reached hard ceiling (%.2f MB). Transitioning to OVERFLOW.", rss, HOT_CACHE_MAX_MEMORY_MB)
            self._hot_overflow = True
            return True
            
        return False

    def _allocate_hot_cache(self, capacity: int):
        cap = min(capacity, HOT_CACHE_MAX_ITEMS)
        new_mat = np.empty((cap, _EMBED_DIM), dtype=np.float32)
        if self._hot_mat is not None and self._hot_count > 0:
            new_mat[:self._hot_count] = self._hot_mat[:self._hot_count]
        self._hot_mat = new_mat
        self._hot_capacity = cap

    def _check_rollover(self):
        """Lazy midnight rollover check. Must be called with self._lock held."""
        today = _get_today()
        if self._hot_date == today:
            return
            
        if self._hot_date and not self._hot_overflow and self._hot_count > 0:
            # Finalize to historical disk cache.
            logger.info("Midnight Rollover: Finalizing day %s for %s", self._hot_date, self.collection_name)
            try:
                mat_active = self._hot_mat[:self._hot_count]
                self._write_historical_partition(self._hot_date, mat_active, self._hot_texts, self._hot_metas)
            except Exception as e:
                logger.error("Rollover failed for %s: %s. MongoDB fallback will be used.", self._hot_date, e)
        
        # Reset Hot Cache for the new day
        self._hot_date = today
        self._hot_count = 0
        self._hot_capacity = _INITIAL_CAPACITY
        self._hot_mat = np.empty((self._hot_capacity, _EMBED_DIM), dtype=np.float32)
        self._hot_texts = []
        self._hot_metas = []
        self._hot_chunk_ids = {}
        self._hot_overflow = False
        
        # Rebuild today's cache from MongoDB
        self._rebuild_hot_cache()

    def _rebuild_hot_cache(self):
        """Rebuild today's cache from MongoDB. Must be called with self._lock held."""
        col = self.connect()
        today = self._hot_date
        
        start_of_day = datetime.strptime(today, "%Y-%m-%d")
        end_of_day = datetime(start_of_day.year, start_of_day.month, start_of_day.day, 23, 59, 59, 999999)
        
        query = {
            "metadata.source_created_at": {
                "$gte": start_of_day,
                "$lte": end_of_day
            }
        }
        
        count = col.count_documents(query)
        if count >= HOT_CACHE_MAX_ITEMS:
            self._hot_overflow = True
            return
            
        # Allocate exactly what's needed or initial capacity
        self._allocate_hot_cache(max(_INITIAL_CAPACITY, count))
            
        cursor = col.find(query)
        idx = 0
        
        for doc in cursor:
            if self._check_memory_bounds():
                break
                
            emb = doc.get("embedding")
            if not emb: continue
            vec = np.array(emb, dtype=np.float32)
            norm = np.linalg.norm(vec)
            if norm > 0.0: vec /= norm
            
            self._hot_mat[idx] = vec
            self._hot_texts.append(doc.get("text", ""))
            meta = doc.get("metadata", {})
            self._hot_metas.append(meta)
            self._hot_chunk_ids[meta.get("chunk_id", "")] = idx
            idx += 1
            
        self._hot_count = idx
        logger.info("Hot cache rebuilt for %s: %d chunks.", today, self._hot_count)

    # -- ingestion / dynamic updates -----------------------------------------

    def upsert_chunks(self, chunks: List[Dict[str, Any]]) -> int:
        if not chunks:
            return 0
            
        col = self.connect()
        ops = []
        for ch in chunks:
            ops.append(
                UpdateOne(
                    {
                        "metadata.document_id": ch["metadata"]["document_id"],
                        "metadata.chunk_index": ch["metadata"]["chunk_index"],
                    },
                    {"$set": ch},
                    upsert=True,
                )
            )
            
        res = col.bulk_write(ops, ordered=False)
        stored = res.upserted_count + res.modified_count
        
        # Dynamically update Hot Cache
        with self._lock:
            self._check_rollover()
            
            if self._hot_overflow:
                return stored
                
            today = self._hot_date
            
            for ch in chunks:
                dt = ch.get("metadata", {}).get("source_created_at")
                if _dt_to_date_str(dt) == today:
                    chunk_id = ch["metadata"].get("chunk_id", "")
                    
                    emb = ch.get("embedding")
                    if not emb: continue
                    vec = np.array(emb, dtype=np.float32)
                    norm = np.linalg.norm(vec)
                    if norm > 0.0: vec /= norm
                    
                    if chunk_id in self._hot_chunk_ids:
                        # Update existing in-place
                        idx = self._hot_chunk_ids[chunk_id]
                        self._hot_mat[idx] = vec
                        self._hot_texts[idx] = ch.get("text", "")
                        self._hot_metas[idx] = ch.get("metadata", {})
                    else:
                        # Append new
                        if self._check_memory_bounds():
                            break
                            
                        if self._hot_count >= self._hot_capacity:
                            self._allocate_hot_cache(self._hot_capacity * 2)
                            
                        idx = self._hot_count
                        self._hot_mat[idx] = vec
                        self._hot_texts.append(ch.get("text", ""))
                        self._hot_metas.append(ch.get("metadata", {}))
                        self._hot_chunk_ids[chunk_id] = idx
                        self._hot_count += 1
                        
        return stored
        
    def delete_chunks(self, chunk_ids: List[str]):
        """Logical delete from RAM, hard delete from Mongo."""
        col = self.connect()
        col.delete_many({"metadata.chunk_id": {"$in": chunk_ids}})
        
        with self._lock:
            if self._hot_date != _get_today() or self._hot_overflow:
                return
            for cid in chunk_ids:
                if cid in self._hot_chunk_ids:
                    # Logical delete - move last element to this spot to keep array dense
                    idx = self._hot_chunk_ids[cid]
                    last_idx = self._hot_count - 1
                    
                    if idx != last_idx:
                        # Swap with last element
                        self._hot_mat[idx] = self._hot_mat[last_idx]
                        self._hot_texts[idx] = self._hot_texts[last_idx]
                        self._hot_metas[idx] = self._hot_metas[last_idx]
                        last_cid = self._hot_metas[last_idx].get("chunk_id", "")
                        self._hot_chunk_ids[last_cid] = idx
                    
                    # Pop last
                    self._hot_texts.pop()
                    self._hot_metas.pop()
                    del self._hot_chunk_ids[cid]
                    self._hot_count -= 1

    # -- historical disk cache -----------------------------------------------

    def _get_hist_paths(self, date_str: str) -> Tuple[str, str]:
        os.makedirs(self.cache_dir, exist_ok=True)
        base = f"{self.collection_name}_{date_str}"
        emb_path = os.path.join(self.cache_dir, f"{base}_embeddings.npy")
        db_path = os.path.join(self.cache_dir, f"{base}_meta.db")
        return emb_path, db_path

    def _write_historical_partition(self, date_str: str, mat: np.ndarray, texts: List[str], metas: List[Dict]):
        if mat is None or len(texts) == 0:
            return
            
        emb_path, db_path = self._get_hist_paths(date_str)
        tmp_emb = emb_path + ".tmp"
        tmp_db = db_path + ".tmp"
        
        if os.path.exists(tmp_emb): os.remove(tmp_emb)
        if os.path.exists(tmp_db): os.remove(tmp_db)
        
        try:
            with open(tmp_emb, "wb") as f:
                np.save(f, mat)
            
            conn = sqlite3.connect(tmp_db)
            conn.execute("CREATE TABLE metadata (candidate_id INTEGER PRIMARY KEY, chunk_id TEXT, text TEXT, meta_json TEXT)")
            conn.execute("CREATE INDEX idx_chunk_id ON metadata(chunk_id)")
            
            rows = []
            for i, (txt, meta) in enumerate(zip(texts, metas)):
                chunk_id = meta.get("chunk_id", "")
                rows.append((i, chunk_id, txt, json.dumps(meta, default=str)))
                
            conn.executemany("INSERT INTO metadata VALUES (?, ?, ?, ?)", rows)
            conn.commit()
            conn.close()
            
            os.replace(tmp_emb, emb_path)
            os.replace(tmp_db, db_path)
        except Exception as e:
            if os.path.exists(tmp_emb): os.remove(tmp_emb)
            if os.path.exists(tmp_db): os.remove(tmp_db)
            raise e

    def _read_historical_metadata(self, date_str: str, candidate_ids: List[int]) -> Tuple[List[str], List[Dict]]:
        _, db_path = self._get_hist_paths(date_str)
        if not os.path.exists(db_path):
            return [], []
            
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        
        placeholders = ",".join("?" * len(candidate_ids))
        cur.execute(f"SELECT candidate_id, text, meta_json FROM metadata WHERE candidate_id IN ({placeholders})", candidate_ids)
        
        results = cur.fetchall()
        conn.close()
        
        lookup = {r[0]: (r[1], json.loads(r[2])) for r in results}
        texts = []
        metas = []
        for cid in candidate_ids:
            if cid in lookup:
                texts.append(lookup[cid][0])
                metas.append(lookup[cid][1])
        return texts, metas
        
    def _get_all_historical_dates(self) -> List[str]:
        if not os.path.exists(self.cache_dir): return []
        dates = set()
        pattern = re.compile(rf"{self.collection_name}_(\d{{4}}-\d{{2}}-\d{{2}})_embeddings\.npy")
        for f in os.listdir(self.cache_dir):
            m = pattern.match(f)
            if m: dates.add(m.group(1))
        return sorted(list(dates), reverse=True)

    # -- query routing -------------------------------------------------------

    def cosine_search(
        self,
        query_vector: List[float],
        top_k: int = 5,
        query_text: Optional[str] = None,
        source_collection: Optional[str] = None,
        explicit_date: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        
        q = np.array(query_vector, dtype=np.float32)
        norm = np.linalg.norm(q)
        if norm > 0: q /= norm
        
        with self._lock:
            self._check_rollover()
            
        results = []
        
        if explicit_date:
            if explicit_date == self._hot_date and not self._hot_overflow:
                results = self._search_hot_cache(q, top_k)
            else:
                results = self._search_historical(q, top_k, explicit_date)
                
            if not results:
                results = self._search_server_side(query_vector, top_k, query_text, source_collection, explicit_date)
                
            return results
            
        else:
            # 1. Today Hot Cache
            if not self._hot_overflow:
                results = self._search_hot_cache(q, top_k)
                
            # 2. Historical Warm Cache (if insufficient)
            if len(results) < top_k:
                hist_dates = self._get_all_historical_dates()
                for d in hist_dates:
                    if len(results) >= top_k: break
                    hist_res = self._search_historical(q, top_k, d)
                    results.extend(hist_res)
                    
                # Deduplicate and sort
                seen = set()
                deduped = []
                for r in sorted(results, key=lambda x: x["score"], reverse=True):
                    cid = r["metadata"].get("chunk_id")
                    if cid not in seen:
                        seen.add(cid)
                        deduped.append(r)
                results = deduped[:top_k]
                
            # 3. Server-Side Fallback
            if len(results) < top_k:
                mongo_results = self._search_server_side(query_vector, top_k, query_text, source_collection)
                seen = {r["metadata"]["chunk_id"] for r in results}
                for mr in mongo_results:
                    if mr["metadata"]["chunk_id"] not in seen:
                        results.append(mr)
                results = sorted(results, key=lambda x: x["score"], reverse=True)[:top_k]
                
            return results

    def _search_hot_cache(self, q: np.ndarray, top_k: int) -> List[Dict]:
        with self._lock:
            if self._hot_count == 0:
                return []
            # Slice active items only
            scores = self._hot_mat[:self._hot_count] @ q
            
        top_indices = np.argsort(scores)[-top_k:][::-1]
        results = []
        for i in top_indices:
            results.append({
                "text": self._hot_texts[i],
                "metadata": self._hot_metas[i],
                "score": float(scores[i])
            })
        return results

    def _search_historical(self, q: np.ndarray, top_k: int, date_str: str) -> List[Dict]:
        emb_path, db_path = self._get_hist_paths(date_str)
        if not os.path.exists(emb_path) or not os.path.exists(db_path):
            return []
            
        try:
            mat = np.load(emb_path, mmap_mode='r')
            if mat.shape[0] == 0: return []
            
            scores = mat @ q
            top_indices = np.argsort(scores)[-top_k:][::-1]
            
            cids = [int(i) for i in top_indices]
            texts, metas = self._read_historical_metadata(date_str, cids)
            
            results = []
            for i, txt, meta in zip(top_indices, texts, metas):
                results.append({
                    "text": txt,
                    "metadata": meta,
                    "score": float(scores[i])
                })
            return results
        except Exception as e:
            logger.error("Historical cache corrupted for %s: %s", date_str, e)
            return []

    # -- mongodb fallback ----------------------------------------------------

    def _search_server_side(
        self,
        query_vector: List[float],
        top_k: int,
        query_text: Optional[str] = None,
        source_collection: Optional[str] = None,
        explicit_date: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        col = self.connect()
        pipeline = []
        
        match_stage = {}
        if source_collection:
            match_stage["metadata.source_collection"] = source_collection
        if query_text:
            match_stage["$text"] = {"$search": query_text}
            
        if explicit_date:
            try:
                start = datetime.strptime(explicit_date, "%Y-%m-%d")
                end = datetime(start.year, start.month, start.day, 23, 59, 59, 999999)
                match_stage["metadata.source_created_at"] = {"$gte": start, "$lte": end}
            except ValueError:
                pass
                
        if match_stage:
            pipeline.append({"$match": match_stage})
            
        pipeline.append({"$sample": {"size": 2000}})
        
        try:
            candidates = list(col.aggregate(pipeline))
        except Exception as exc:
            logger.error("Server-side search failed: %s", exc)
            return []
            
        if not candidates:
            return []
            
        mat = np.array([c["embedding"] for c in candidates if "embedding" in c], dtype=np.float32)
        if mat.shape[0] == 0:
            return []
            
        norms = np.linalg.norm(mat, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        mat /= norms
        
        q = np.array(query_vector, dtype=np.float32)
        q_norm = np.linalg.norm(q)
        if q_norm > 0: q /= q_norm
        
        scores = mat @ q
        top_indices = np.argsort(scores)[-top_k:][::-1]
        
        results = []
        for i in top_indices:
            idx = int(i)
            cand = candidates[idx]
            results.append({
                "text": cand.get("text", ""),
                "metadata": cand.get("metadata", {}),
                "score": float(scores[idx]),
            })
            
        return results
