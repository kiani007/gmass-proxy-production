import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT; // no fallback!

// Middleware to parse JSON bodies
app.use(express.json({ limit: '10mb' }));

// Configuration
const CONFIG = {
  TIMEOUT: 30000, // 30 seconds
  MAX_CONCURRENT_REQUESTS: 10,
  RATE_LIMIT_DELAY: 100, // ms between requests
  BATCH_SIZE: 50 // max emails per batch
};

// Simple request queue for rate limiting
let requestQueue = [];
let isProcessing = false;

// Process queue with rate limiting
async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  
  isProcessing = true;
  
  while (requestQueue.length > 0) {
    const { email, key, resolve, reject } = requestQueue.shift();
    
    try {
      const result = await verifySingleEmail(email, key);
      resolve(result);
    } catch (error) {
      reject(error);
    }
    
    // Rate limiting delay
    if (requestQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.RATE_LIMIT_DELAY));
    }
  }
  
  isProcessing = false;
}

// Single email verification with timeout
async function verifySingleEmail(email, key) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.TIMEOUT);
  
  try {
    const url = `https://verify.gmass.co/verify?email=${encodeURIComponent(email)}&key=${encodeURIComponent(key)}`;
    
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'GMass-Proxy/1.0'
      }
    });
    
    const text = await response.text();
    
    return {
      email,
      success: true,
      data: text,
      status: response.status
    };
  } catch (error) {
    return {
      email,
      success: false,
      error: error.message,
      isTimeout: error.name === 'AbortError'
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Queue-based verification with rate limiting
async function verifyEmailWithQueue(email, key) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ email, key, resolve, reject });
    processQueue();
  });
}

// Batch verification with concurrency control
async function verifyBatchEmails(emails, key) {
  const results = [];
  const batches = [];
  
  // Split emails into batches
  for (let i = 0; i < emails.length; i += CONFIG.BATCH_SIZE) {
    batches.push(emails.slice(i, i + CONFIG.BATCH_SIZE));
  }
  
  for (const batch of batches) {
    const batchPromises = batch.map(email => verifyEmailWithQueue(email, key));
    const batchResults = await Promise.allSettled(batchPromises);
    
    results.push(...batchResults.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        return {
          email: batch[index],
          success: false,
          error: result.reason.message
        };
      }
    }));
  }
  
  return results;
}

// Original single email endpoint (maintained for backward compatibility)
app.get('/verify', async (req, res) => {
  const { email, key } = req.query;

  if (!email || !key) {
    return res.status(400).json({ error: "Missing email or key" });
  }

  try {
    const result = await verifyEmailWithQueue(email, key);
    
    if (result.success) {
      res.status(200).send(result.data);
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// New batch processing endpoint
app.post('/verify/batch', async (req, res) => {
  const { emails, key } = req.body;

  if (!emails || !Array.isArray(emails) || !key) {
    return res.status(400).json({ 
      error: "Missing emails array or key. Expected: { emails: string[], key: string }" 
    });
  }

  if (emails.length === 0) {
    return res.status(400).json({ error: "Emails array cannot be empty" });
  }

  if (emails.length > 1000) {
    return res.status(400).json({ error: "Maximum 1000 emails per batch" });
  }

  try {
    console.log(`🔄 Processing batch of ${emails.length} emails`);
    const startTime = Date.now();
    
    const results = await verifyBatchEmails(emails, key);
    
    const endTime = Date.now();
    const processingTime = endTime - startTime;
    
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.length - successCount;
    
    console.log(`✅ Batch completed: ${successCount} success, ${failureCount} failed in ${processingTime}ms`);
    
    res.status(200).json({
      total: results.length,
      successful: successCount,
      failed: failureCount,
      processingTime,
      results
    });
  } catch (err) {
    console.error('❌ Batch processing error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    queueLength: requestQueue.length,
    isProcessing,
    timestamp: new Date().toISOString()
  });
});

// Server startup
app.listen(PORT, () => {
  console.log(`✅ GMass Proxy running on port ${PORT}`);
  console.log(`📊 Configuration: ${CONFIG.MAX_CONCURRENT_REQUESTS} concurrent, ${CONFIG.RATE_LIMIT_DELAY}ms delay`);
});
