import axios from 'axios';
import { CENTERS_CONFIG } from './config/centers.js';

async function testBackend() {
  try {
    const loginRes = await axios.post('http://localhost:5000/api/auth/login', {
      role: 'centre',
      id: 'GAIL',
      password: 'center123'
    });
    const token = loginRes.data.token;
    console.log("Got token.");

    const centerRes = await axios.get('http://localhost:5000/api/data/center', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = centerRes.data;
    console.log(`Profiles: ${data.profiles.length}`);
    console.log(`Tests: ${data.tests.length}`);
    console.log(`Test Columns:`, data.testColumns);
    
    if (data.profiles.length > 0) {
      console.log("Sample Profile ROLL_KEY:", data.profiles[0].ROLL_KEY);
      const studentTests = data.tests.find(t => t.ROLL_KEY === data.profiles[0].ROLL_KEY);
      console.log("Sample Test Record:", !!studentTests ? "Exists" : "MISSING for ROLL_KEY " + data.profiles[0].ROLL_KEY);
    }
  } catch (error) {
    console.error(error.response?.data || error.message);
  }
}
testBackend();
