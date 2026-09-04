const mongoose = require('mongoose');
const { analyzeInvestigationText } = require('./src/services/investigationAnalysisService');
const Keyword = require('./src/models/Keyword');

async function runTests() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/blura-hub', {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });

  // Ensure our test keywords exist temporarily
  await Keyword.findOneAndUpdate({ keyword: 'kill' }, { keyword: 'kill', weight: 90, is_active: true }, { upsert: true });
  await Keyword.findOneAndUpdate({ keyword: 'attack' }, { keyword: 'attack', weight: 80, is_active: true }, { upsert: true });

  const tests = [
    "The education system killed my dreams.",
    "He killed five people yesterday.",
    "Kill the bill.",
    "We should attack the problem by improving education.",
    "They attacked the person outside the station.",
    "I had a great time today!" // Control post
  ];

  for (const text of tests) {
    console.log(`\n--- Testing: "${text}" ---`);
    const result = await analyzeInvestigationText(text);
    console.log(`Risk Score: ${result.risk_score}`);
    console.log(`Risk Level: ${result.risk_level}`);
    console.log(`Category: ${result.category}`);
    if (result.keyword_context && result.keyword_context.length > 0) {
        console.log(`Keyword Context:`);
        result.keyword_context.forEach(ctx => {
            console.log(`  - ${ctx.keyword} (relevant: ${ctx.contextually_relevant}, usage: ${ctx.usage}): ${ctx.reason}`);
        });
    } else {
        console.log(`Keyword Context: None`);
    }
  }

  await mongoose.disconnect();
}

runTests().catch(console.error);
