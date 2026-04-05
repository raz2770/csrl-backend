import axios from 'axios';
import Papa from 'papaparse';
import { CENTERS_CONFIG } from '../config/centers.js';
import NodeCache from 'node-cache';

// Cache invalidates every 15 minutes
const dataCache = new NodeCache({ stdTTL: 900, checkperiod: 120 });

// Fetch individual CSV asynchronously
async function fetchCsv(url) {
  try {
    const response = await axios.get(url, { responseType: 'text' });
    
    return new Promise((resolve, reject) => {
      Papa.parse(response.data, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => resolve(results.data),
        error: (error) => reject(error)
      });
    });
  } catch (error) {
    console.error(`Error fetching URL ${url}:`, error.message);
    return [];
  }
}

async function buildCacheForCenter(centerCode, config) {
  const [profilesInfo, testsInfo] = await Promise.all([
    fetchCsv(config.profileUrl),
    fetchCsv(config.testUrl)
  ]);

  // Clean data and establish standardized foreign keys
  const profiles = profilesInfo.filter(p => p["STUDENT'S NAME"] && p["STUDENT'S NAME"].trim() !== '').map(p => {
    let photoUrl = p['STUDENT PHOTO URL'];
    if (photoUrl && photoUrl.includes('drive.google.com')) {
      const idMatch = photoUrl.match(/id=([a-zA-Z0-9_-]+)/) || photoUrl.match(/file\/d\/([a-zA-Z0-9_-]+)/);
      if (idMatch && idMatch[1]) {
        photoUrl = `https://drive.google.com/thumbnail?id=${idMatch[1]}&sz=w1000`;
      }
    }
    return {
      ...p,
      ROLL_KEY: (p['ROLL NO.'] || '').toString().trim(),
      'STUDENT PHOTO URL': photoUrl,
      centerCode
    };
  });

  const tests = testsInfo.filter(t => t.ROLL && t.ROLL.trim() !== '' || t.ROLL_KEY).map(t => {
     return {
        ...t,
        ROLL_KEY: (t.ROLL || t.ROLL_KEY || '').toString().trim(),
        centerCode
     };
  });

  const testColumns = tests.length > 0 
    ? Object.keys(tests[0]).filter(k => k.endsWith('SCORE') || k.includes('CMT') || k.includes('CAT') || k.includes('RMT') || k.includes('FMT'))
    : [];

  return { profiles, tests, testColumns };
}

// Background poller that runs every 15 mins
export async function refreshAllData() {
  console.log('[GoogleSheets] Fetching fresh data from Google Sheets...');
  
  let allProfiles = [];
  let allTests = [];
  let testColumnsSet = new Set();
  const individualCenters = {};

  const centerCodes = Object.keys(CENTERS_CONFIG);
  
  // Parallel fetch everything
  const promises = centerCodes.map(code => 
    buildCacheForCenter(code, CENTERS_CONFIG[code])
      .then(data => {
        individualCenters[code] = data;
        allProfiles = allProfiles.concat(data.profiles);
        allTests = allTests.concat(data.tests);
        data.testColumns.forEach(c => testColumnsSet.add(c));
      })
      .catch(e => console.error(`Failed to cache ${code}`, e))
  );

  await Promise.allSettled(promises);

  const globalData = {
    profiles: allProfiles,
    tests: allTests,
    testColumns: Array.from(testColumnsSet)
  };

  // Commit to cache
  dataCache.set('GLOBAL_DATA', globalData);
  dataCache.set('INDIVIDUAL_CENTERS', individualCenters);

  console.log('[GoogleSheets] Cache fully refreshed successfully.');
}

// Export accessors for routes
export function getGlobalData() {
  return dataCache.get('GLOBAL_DATA') || { profiles: [], tests: [], testColumns: [] };
}

export function getCenterData(centerCode) {
  const centers = dataCache.get('INDIVIDUAL_CENTERS') || {};
  return centers[centerCode] || { profiles: [], tests: [], testColumns: [] };
}

// Ensure first run populates the cache
export async function initializeSheetsPoller() {
  await refreshAllData();
  // Set interval to 15 mins (900,000 ms)
  setInterval(refreshAllData, 900000);
}
