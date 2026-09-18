import { useState, useEffect, createContext, useContext } from 'react';
import api from '../lib/api';
import { toast } from 'sonner';

const AuthContext = createContext(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

/** One-shot check on login / app load (refresh) — mirrors backend blugateHealthState. */
const notifyIfBlugateUnauthorized = async () => {
  try {
    const response = await api.get('/health/status');
    const blugate = response.data?.data?.blugate;
    if (blugate?.status === 'unauthorized') {
      toast.error(
        blugate.message ||
          'Your API limit has been exceeded. Please renew your API limits to continue receiving live content.',
        { duration: 10000 }
      );
    }
  } catch (e) {
    // Health check is best-effort — never block login/app load on it.
  }
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const initAuth = async () => {
      if (token) {
        try {
          const response = await api.get('/auth/me');
          setUser(response.data);
          notifyIfBlugateUnauthorized();
        } catch (error) {
          console.error('Failed to fetch user:', error);
          logout();
        }
      }
      setLoading(false);
    };

    initAuth();
  }, [token]);

  const login = async (email, password) => {
    try {
      const response = await api.post('/auth/login', { email, password });
      const { access_token, user: userData } = response.data;

      localStorage.setItem('token', access_token);
      setToken(access_token);
      setUser(userData);

      toast.success('Logged in successfully');
      notifyIfBlugateUnauthorized();
      return userData;
    } catch (error) {
      const message = error.response?.data?.message || 'Login failed';
      toast.error(message);
      throw error;
    }
  };

  const register = async (email, password, full_name, role = 'level-1') => {
    try {
      await api.post('/auth/register', { email, password, full_name, role });
      return login(email, password);
    } catch (error) {
      const message = error.response?.data?.message || 'Registration failed';
      toast.error(message);
      throw error;
    }
  };

  const logout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
    toast.info('Logged out');
  };

  return (
    <AuthContext.Provider value={{ user, token, login, register, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
};

export default AuthContext;
