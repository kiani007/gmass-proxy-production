# GMass Proxy

A high-performance Node.js proxy for the GMass Email Verification API with support for concurrency, batch processing, and rate limiting. Designed for cloud environments with restricted access (like Supabase, Deno Deploy, etc.).

## Features

- ✅ **Single Email Verification** - Original endpoint maintained for backward compatibility
- ✅ **Batch Processing** - Verify multiple emails in one request
- ✅ **Concurrency Control** - Queue-based processing with rate limiting
- ✅ **Timeout Handling** - Configurable timeouts to prevent hanging requests
- ✅ **Error Handling** - Comprehensive error reporting and logging
- ✅ **Health Monitoring** - Real-time queue status and processing metrics

## API Endpoints

### Single Email Verification
```http
GET /verify?email=test@example.com&key=your-api-key
```

**Response:** Raw GMass verification result

### Batch Email Verification
```http
POST /verify/batch
Content-Type: application/json

{
  "emails": ["email1@example.com", "email2@example.com", "email3@example.com"],
  "key": "your-api-key"
}
```

**Response:**
```json
{
  "total": 3,
  "successful": 2,
  "failed": 1,
  "processingTime": 1500,
  "results": [
    {
      "email": "email1@example.com",
      "success": true,
      "data": "verification result",
      "status": 200
    },
    {
      "email": "email2@example.com",
      "success": false,
      "error": "timeout",
      "isTimeout": true
    }
  ]
}
```

### Health Check
```http
GET /health
```

**Response:**
```json
{
  "status": "healthy",
  "queueLength": 0,
  "isProcessing": false,
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

## Configuration

The server uses the following configuration (can be modified in `server.js`):

- **TIMEOUT**: 30 seconds per request
- **RATE_LIMIT_DELAY**: 100ms between requests
- **BATCH_SIZE**: 50 emails per batch
- **MAX_CONCURRENT_REQUESTS**: 10 concurrent operations

## Usage Examples

### Single Email (JavaScript)
```javascript
const response = await fetch('/verify?email=test@example.com&key=your-key');
const result = await response.text();
```

### Batch Processing (JavaScript)
```javascript
const response = await fetch('/verify/batch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    emails: ['email1@example.com', 'email2@example.com'],
    key: 'your-api-key'
  })
});

const results = await response.json();
console.log(`Processed ${results.total} emails in ${results.processingTime}ms`);
```

### cURL Examples
```bash
# Single email
curl "http://localhost:3000/verify?email=test@example.com&key=your-key"

# Batch processing
curl -X POST http://localhost:3000/verify/batch \
  -H "Content-Type: application/json" \
  -d '{"emails":["email1@example.com","email2@example.com"],"key":"your-key"}'
```

## Deployment

1. Set the `PORT` environment variable
2. Run `npm start`
3. The server will be available on the specified port

## Performance

- **Rate Limiting**: Built-in delays prevent overwhelming the GMass API
- **Queue Management**: Requests are queued and processed sequentially
- **Batch Processing**: Up to 1000 emails per batch request
- **Timeout Protection**: 30-second timeout prevents hanging requests
- **Error Recovery**: Failed requests are logged and reported

## Error Handling

The proxy handles various error scenarios:
- Network timeouts
- Invalid API keys
- Rate limiting from GMass
- Malformed requests
- Server errors

All errors are logged and returned with appropriate HTTP status codes.