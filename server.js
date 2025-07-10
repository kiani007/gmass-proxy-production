import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000; // Add fallback for container deployment

// Middleware to parse JSON bodies
app.use(express.json({ limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
  });
  
  next();
});

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
let isShuttingDown = false;

// Graceful shutdown handling
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

async function gracefulShutdown() {
  console.log('🔄 Received shutdown signal, starting graceful shutdown...');
  isShuttingDown = true;
  
  // Stop accepting new requests
  server.close(() => {
    console.log('✅ HTTP server closed');
  });
  
  // Wait for current requests to complete
  if (requestQueue.length > 0) {
    console.log(`⏳ Waiting for ${requestQueue.length} queued requests to complete...`);
    await new Promise(resolve => {
      const checkQueue = () => {
        if (requestQueue.length === 0) {
          resolve();
        } else {
          setTimeout(checkQueue, 100);
        }
      };
      checkQueue();
    });
  }
  
  console.log('✅ Graceful shutdown completed');
  process.exit(0);
}

// Process queue with rate limiting
async function processQueue() {
  if (isProcessing || requestQueue.length === 0 || isShuttingDown) return;
  
  isProcessing = true;
  
  while (requestQueue.length > 0 && !isShuttingDown) {
    const { email, key, resolve, reject } = requestQueue.shift();
    
    try {
      const result = await verifySingleEmail(email, key);
      resolve(result);
    } catch (error) {
      reject(error);
    }
    
    // Rate limiting delay
    if (requestQueue.length > 0 && !isShuttingDown) {
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
  if (isShuttingDown) {
    throw new Error('Server is shutting down');
  }
  
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
    if (isShuttingDown) {
      // Add remaining emails as failed due to shutdown
      results.push(...batch.map(email => ({
        email,
        success: false,
        error: 'Server is shutting down'
      })));
      break;
    }
    
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
  if (isShuttingDown) {
    return res.status(503).json({ error: "Server is shutting down" });
  }

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
  if (isShuttingDown) {
    return res.status(503).json({ error: "Server is shutting down" });
  }

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
    status: isShuttingDown ? 'shutting_down' : 'healthy',
    queueLength: requestQueue.length,
    isProcessing,
    isShuttingDown,
    timestamp: new Date().toISOString()
  });
});

// Root endpoint for container health checks
app.get('/', (req, res) => {
  res.status(200).json({
    service: 'GMass Proxy',
    version: '1.0.0',
    status: isShuttingDown ? 'shutting_down' : 'healthy',
    timestamp: new Date().toISOString()
  });
});

// Server startup
const server = app.listen(PORT, () => {
  console.log(`✅ GMass Proxy running on port ${PORT}`);
  console.log(`📊 Configuration: ${CONFIG.MAX_CONCURRENT_REQUESTS} concurrent, ${CONFIG.RATE_LIMIT_DELAY}ms delay`);
  console.log(`🚀 Ready to handle requests`);
});
