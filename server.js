// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

// Polyfill fetch for Node.js
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
// Serve static files from public directory
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html for root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Robust CORS configuration
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'https://solymarket.cc',
  'https://www.solymarket.cc',
  'https://api.solymarket.cc',
  'https://solymarket-10.onrender.com',
];
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      console.error(`CORS not allowed from this origin: ${origin}`);
      return callback(new Error('CORS not allowed from this origin: ' + origin), false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
}));

// Real treasury endpoint: returns the total volume as the treasury balance (placeholder logic)
app.get('/api/treasury', async (req, res) => {
  try {
    // Use the same logic as the /api/stats endpoint for totalVolume
    const volumeResult = await queryDatabase('SELECT COALESCE(SUM(total_volume), 0) as volume FROM markets');
    const treasury = parseFloat(volumeResult.rows[0].volume || 0);
    res.json({ treasury });
  } catch (error) {
    console.error('Treasury API error:', error);
    res.status(500).json({ error: 'Failed to fetch treasury', details: error.message });
  }
});

app.use(express.json({ limit: '10mb' }));

// Admin: Delete market by id
app.post('/api/admin/delete-market/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { address } = req.query;
  const adminAddresses = ['DkoKjWfXRc7frJkQoVC1xL76BUBTzgmTRzm5KaQbRAyd'];
    if (!adminAddresses.includes(address)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    // Delete market and cascade bets
    const result = await queryDatabase('DELETE FROM markets WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Market not found' });
    }
    console.log(`Market ${id} deleted by admin ${address}`);
    res.json({ message: 'Market deleted successfully' });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Failed to delete market', details: error.message });
  }
});
const PORT = process.env.PORT || 3001;

// PostgreSQL configuration - Use environment variables with fallback
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // required for Render
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test database connection
pool.on('connect', () => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('PostgreSQL connection error:', err.message);
});

// Cloudinary configuration - Use environment variables
if (
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
} else {
  console.warn('Warning: Cloudinary environment variables are missing. Image upload will not work.');
}

// Multer configuration for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files allowed'), false);
    }
  }
});

// Initialize database tables
async function initializeDatabase() {
  try {
    console.log('Initializing database tables...');

    // Create markets table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS markets (
        id SERIAL PRIMARY KEY,
        title VARCHAR(500) NOT NULL,
        description TEXT,
        category VARCHAR(50) DEFAULT 'other',
        creator_address VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        end_date TIMESTAMP,
        total_volume DECIMAL(18, 9) DEFAULT 0,
        total_bets INTEGER DEFAULT 0,
        options JSONB DEFAULT '[]',
        status VARCHAR(20) DEFAULT 'under_review',
        creation_signature VARCHAR(150),
        initial_liquidity DECIMAL(18, 9) DEFAULT 0,
        resolved BOOLEAN DEFAULT false,
        resolution_value TEXT,
        metadata JSONB DEFAULT '{}',
        market_image TEXT
      );
    `);

    // Create bets table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bets (
        id SERIAL PRIMARY KEY,
        market_id INTEGER REFERENCES markets(id) ON DELETE CASCADE,
        bettor_address VARCHAR(100) NOT NULL,
        option_id INTEGER NOT NULL,
        amount DECIMAL(18, 9) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        transaction_signature VARCHAR(150),
        status VARCHAR(20) DEFAULT 'confirmed',
        payout_amount DECIMAL(18, 9) DEFAULT 0,
        claimed BOOLEAN DEFAULT false,
        metadata JSONB DEFAULT '{}'
      );
    `);

    // Create comments table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id SERIAL PRIMARY KEY,
        bet_id INTEGER REFERENCES bets(id) ON DELETE CASCADE,
        user_address VARCHAR(100) NOT NULL,
        comment_text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create indexes for better performance
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_markets_creator ON markets(creator_address);
      CREATE INDEX IF NOT EXISTS idx_markets_category ON markets(category);
      CREATE INDEX IF NOT EXISTS idx_markets_status ON markets(status);
      CREATE INDEX IF NOT EXISTS idx_bets_market ON bets(market_id);
      CREATE INDEX IF NOT EXISTS idx_bets_bettor ON bets(bettor_address);
      CREATE INDEX IF NOT EXISTS idx_bets_transaction ON bets(transaction_signature);
      CREATE INDEX IF NOT EXISTS idx_comments_bet_id ON comments(bet_id);
      CREATE INDEX IF NOT EXISTS idx_comments_user_address ON comments(user_address);
    `);

    console.log('Database tables initialized successfully');
  } catch (error) {
    console.error('Database initialization failed:', error);
    throw error;
  }
}

// Utility function to handle database queries with error logging
async function queryDatabase(query, params = []) {
  try {
    const result = await pool.query(query, params);
    return result;
  } catch (error) {
    console.error('Database query error:', error.message);
    console.error('Query:', query);
    console.error('Params:', params);
    throw error;
  }
}

// API Routes
// Get live order book for a market (production-ready)
app.get('/api/orderbook/:marketId', async (req, res) => {
  try {
    const { marketId } = req.params;
    // Fetch all confirmed bets for this market
    const betsResult = await queryDatabase(
      'SELECT option_id, amount, created_at, bettor_address, transaction_signature FROM bets WHERE market_id = $1 AND status = $2 ORDER BY created_at DESC',
      [marketId, 'confirmed']
    );
    // Fetch market options for mapping
    const marketResult = await queryDatabase('SELECT options FROM markets WHERE id = $1', [marketId]);
    if (marketResult.rows.length === 0) {
      return res.status(404).json({ error: 'Market not found' });
    }
    const options = typeof marketResult.rows[0].options === 'string'
      ? JSON.parse(marketResult.rows[0].options)
      : marketResult.rows[0].options;

    // Group bets by option and side (simulate order book: last N bets as bids, last N as asks)
    // In a real AMM, this would be replaced by on-chain orderbook or AMM state
    const orderBook = [];
    const N = 20; // max rows per side per outcome
    for (let i = 0; i < options.length; i++) {
      // Bids: bets on this outcome (simulate as 'bid')
      const bids = betsResult.rows
        .filter(b => b.option_id === i)
        .slice(0, N)
        .map(bet => ({
          outcomeId: i,
          side: 'bid',
          price: 1, // Placeholder: price logic can be improved if AMM/odds available
          amount: parseFloat(bet.amount),
          address: bet.bettor_address,
          time: bet.created_at,
          transactionSignature: bet.transaction_signature // Always provide as camelCase for frontend
        }));
      // Asks: simulate as opposite side (for real CLOB, fetch from on-chain)
      // Here, we just leave asks empty or simulate with dummy data
      const asks = [];
      orderBook.push(...bids, ...asks);
    }
    res.json({ orderBook });
  } catch (error) {
    console.error('Order book API error:', error);
    res.status(500).json({ error: 'Failed to fetch order book', details: error.message });
  }
});

// Health check
// Enhanced health check with diagnostics
app.get('/api/health', async (req, res) => {
  const health = { status: 'ok', timestamp: new Date().toISOString(), diagnostics: {} };
  try {
    await pool.query('SELECT 1');
    health.diagnostics.db = 'ok';
  } catch (error) {
    health.diagnostics.db = 'error: ' + error.message;
    health.status = 'error';
  }
  health.diagnostics.env = process.env.NODE_ENV || 'development';
  health.diagnostics.uptime = process.uptime();
  res.status(health.status === 'ok' ? 200 : 500).json(health);
});

// Get platform stats
app.get('/api/stats', async (req, res) => {
  try {
    const [marketsResult, betsResult, volumeResult] = await Promise.all([
      queryDatabase('SELECT COUNT(*) as count FROM markets WHERE status = $1', ['active']),
      queryDatabase('SELECT COUNT(*) as count FROM bets WHERE status = $1', ['confirmed']),
      queryDatabase('SELECT COALESCE(SUM(total_volume), 0) as volume FROM markets')
    ]);

    res.json({
      totalMarkets: parseInt(marketsResult.rows[0].count),
      totalBets: parseInt(betsResult.rows[0].count),
      totalVolume: parseFloat(volumeResult.rows[0].volume || 0),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch stats',
      details: error.message 
    });
  }
});

// Get all markets - FIXED VERSION
app.get('/api/markets', async (req, res) => {
  try {
    const { category, status, limit = 50, offset = 0 } = req.query;
    
    // Build base query
    let query = `
      SELECT 
        m.*,
        COUNT(b.id) as bet_count,
        COALESCE(SUM(b.amount), 0) as volume
      FROM markets m 
      LEFT JOIN bets b ON m.id = b.market_id AND b.status = 'confirmed'
      WHERE 1=1
    `;
    
    const params = [];
    
    // Filter by status if specified, otherwise show active and under_review
    if (status) {
      query += ` AND m.status = $${params.length + 1}`;
      params.push(status);
    } else {
      query += ` AND m.status IN ('active', 'under_review')`;
    }
    
    if (category && category !== 'all') {
      query += ` AND m.category = $${params.length + 1}`;
      params.push(category);
    }
    
    query += `
      GROUP BY m.id 
      ORDER BY m.created_at DESC 
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await queryDatabase(query, params);
    
    const markets = result.rows.map(row => ({
      ...row,
      total_volume: parseFloat(row.volume || 0),
      total_bets: parseInt(row.bet_count || 0),
      options: typeof row.options === 'string' ? JSON.parse(row.options) : row.options
    }));

    res.json({ 
      markets,
      count: markets.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch markets',
      details: error.message 
    });
  }
});

// Get specific market
app.get('/api/markets/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const marketResult = await queryDatabase(`
      SELECT 
        m.*,
        COUNT(b.id) as bet_count,
        COALESCE(SUM(b.amount), 0) as volume
      FROM markets m 
      LEFT JOIN bets b ON m.id = b.market_id AND b.status = 'confirmed'
      WHERE m.id = $1
      GROUP BY m.id
    `, [id]);

    if (marketResult.rows.length === 0) {
      return res.status(404).json({ error: 'Market not found' });
    }

    const market = marketResult.rows[0];
    market.total_volume = parseFloat(market.volume || 0);
    market.total_bets = parseInt(market.bet_count || 0);
    market.options = typeof market.options === 'string' ? JSON.parse(market.options) : market.options;

    // Get bets for this market
    const betsResult = await queryDatabase(`
      SELECT * FROM bets 
      WHERE market_id = $1 AND status = 'confirmed'
      ORDER BY created_at DESC
    `, [id]);

    market.bets = betsResult.rows;

    res.json({ market });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch market',
      details: error.message 
    });
  }
});

// Create new market - FIXED TO ACCEPT BOTH FORMATS AND SET STATUS TO UNDER_REVIEW
app.post('/api/markets', async (req, res) => {
  try {
    const {
      title,
      description = '',
      category = 'other',
      creator_address,
      creatorAddress,
      endDate,
      initialLiquidity = 0,
      options = [],
      creationSignature
    } = req.body;

    // Handle both creator_address and creatorAddress formats
    const creatorAddr = creator_address || creatorAddress;

    // Admin wallet address for free/pre-uploaded markets
    const adminAddresses = ['DkoKjWfXRc7frJkQoVC1xL76BUBTzgmTRzm5KaQbRAyd'];
    const isAdmin = adminAddresses.includes(creatorAddr);

    // Validation
    if (!title || !creatorAddr) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['title', 'creator_address or creatorAddress']
      });
    }

    if (title.length < 10) {
      return res.status(400).json({ 
        error: 'Title must be at least 10 characters long' 
      });
    }

    // Process options - handle both array and string formats
    let processedOptions = [];
    if (Array.isArray(options)) {
      processedOptions = options;
    } else if (typeof options === 'string') {
      try {
        processedOptions = JSON.parse(options);
      } catch (e) {
        processedOptions = [
          { name: 'Yes', image: null },
          { name: 'No', image: null }
        ];
      }
    } else {
      processedOptions = [
        { name: 'Yes', image: null },
        { name: 'No', image: null }
      ];
    }


    // If admin, allow free/pre-uploaded market (no initialLiquidity or creationSignature required)
    let marketInsert;
    if (isAdmin) {
      marketInsert = await queryDatabase(`
        INSERT INTO markets (
          title, description, category, creator_address, 
          end_date, initial_liquidity, options, creation_signature, status, market_image
        ) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
        RETURNING *
      `, [
        title, 
        description, 
        category, 
        creatorAddr, 
        endDate ? new Date(endDate) : null,
        0, // Free market, no initial liquidity required
        JSON.stringify(processedOptions),
        null, // No creation signature required
        'under_review',
        req.body.marketImage || null
      ]);
    } else {
      // Normal user flow: require minimum initialLiquidity and creationSignature
      const minInitialLiquidity = 0.1; // Minimum required, adjust as needed
      if (!initialLiquidity || isNaN(initialLiquidity) || parseFloat(initialLiquidity) < minInitialLiquidity) {
        return res.status(400).json({
          error: `A minimum initial liquidity of ${minInitialLiquidity} SOL is required to create a market.`
        });
      }
      if (!creationSignature) {
        return res.status(400).json({
          error: 'A creation signature is required to create a market.'
        });
      }
      marketInsert = await queryDatabase(`
        INSERT INTO markets (
          title, description, category, creator_address, 
          end_date, initial_liquidity, options, creation_signature, status, market_image
        ) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
        RETURNING *
      `, [
        title, 
        description, 
        category, 
        creatorAddr, 
        endDate ? new Date(endDate) : null,
        parseFloat(initialLiquidity),
        JSON.stringify(processedOptions),
        creationSignature,
        'under_review',
        req.body.marketImage || null
      ]);
    }

    const market = marketInsert.rows[0];
    market.options = typeof market.options === 'string' ? JSON.parse(market.options) : market.options;

    console.log('Market created:', market.id, title, '- Status: under_review', isAdmin ? '(admin free market)' : '');

    res.status(201).json({ 
      market,
      message: isAdmin ? 'Admin market created for free and submitted for review' : 'Market created successfully and submitted for review'
    });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      error: 'Failed to create market',
      details: error.message 
    });
  }
});

// Get bets for a user - FIXED VERSION
app.get('/api/bets', async (req, res) => {
  try {
    const { address, market_id, limit = 50, offset = 0 } = req.query;
    // Address is optional if market_id is provided
    if (!address && !market_id) {
      return res.status(400).json({ error: 'Either address or market_id parameter required' });
    }

    let query = `
      SELECT 
        b.*,
        m.title as market_title,
        m.category as market_category,
        m.status as market_status
      FROM bets b
      JOIN markets m ON b.market_id = m.id
      WHERE b.status = 'confirmed'
    `;
    const params = [];
    if (address) {
      query += ` AND b.bettor_address = $${params.length + 1}`;
      params.push(address);
    }
    if (market_id) {
      query += ` AND b.market_id = $${params.length + 1}`;
      params.push(market_id);
    }
    query += ` ORDER BY b.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));
    const result = await queryDatabase(query, params);
    res.json({ 
      bets: result.rows,
      count: result.rows.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch bets',
      details: error.message 
    });
  }
});

// Place a bet
app.post('/api/bets', async (req, res) => {
  try {
    const {
      marketId,
      bettorAddress,
      optionId,
      amount,
      transactionSignature
    } = req.body;

    // Validation
    if (!marketId || !bettorAddress || optionId === undefined || !amount || !transactionSignature) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['marketId', 'bettorAddress', 'optionId', 'amount', 'transactionSignature']
      });
    }

    // Check if market exists and is active
    const marketResult = await queryDatabase(
      'SELECT * FROM markets WHERE id = $1 AND status = $2', 
      [marketId, 'active']
    );

    if (marketResult.rows.length === 0) {
      return res.status(404).json({ error: 'Market not found or inactive' });
    }

    // Check if transaction signature already exists (prevent double-spending)
    const existingBet = await queryDatabase(
      'SELECT id FROM bets WHERE transaction_signature = $1', 
      [transactionSignature]
    );

    if (existingBet.rows.length > 0) {
      return res.status(409).json({ error: 'Bet already recorded for this transaction' });
    }

    // Insert bet
    const result = await queryDatabase(`
      INSERT INTO bets (market_id, bettor_address, option_id, amount, transaction_signature) 
      VALUES ($1, $2, $3, $4, $5) 
      RETURNING *
    `, [marketId, bettorAddress, parseInt(optionId), parseFloat(amount), transactionSignature]);

    // Update market volume
    await queryDatabase(`
      UPDATE markets 
      SET 
        total_volume = total_volume + $1,
        total_bets = total_bets + 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [parseFloat(amount), marketId]);

    const bet = result.rows[0];
    console.log('Bet placed:', bet.id, `${amount} SOL on market ${marketId}`);

    res.status(201).json({ 
      bet,
      message: 'Bet placed successfully'
    });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      error: 'Failed to place bet',
      details: error.message 
    });
  }
});

// Image upload endpoint - FIXED TO HANDLE 'file' FIELD NAME
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    console.log('Uploading image:', req.file.originalname, `${(req.file.size / 1024).toFixed(1)}KB`);

    // Create readable stream from buffer
    const stream = Readable.from(req.file.buffer);

    // Upload to Cloudinary
    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'image',
          folder: 'solymarket',
          transformation: [
            { width: 400, height: 400, crop: 'fill', gravity: 'face' },
            { quality: 'auto:good' }
          ]
        },
        (error, result) => {
          if (error) {
            console.error('Cloudinary upload error:', error);
            reject(error);
          } else {
            console.log('Image uploaded successfully:', result.secure_url);
            resolve(result);
          }
        }
      );
      
      stream.pipe(uploadStream);
    });

    res.json({
      url: result.secure_url,
      publicId: result.public_id,
      message: 'Image uploaded successfully'
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      error: 'Failed to upload image',
      details: error.message 
    });
  }
});

// Admin routes (basic implementation)
app.get('/api/admin/stats', async (req, res) => {
  try {
    const { address } = req.query;
    
    // Simple admin check - in production, implement proper authentication
    const adminAddresses = [
      'DkoKjWfXRc7frJkQoVC1xL76BUBTzgmTRzm5KaQbRAyd',
      // Add other admin addresses here
    ];
    
    if (!adminAddresses.includes(address)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const [markets, bets, volume] = await Promise.all([
      queryDatabase('SELECT COUNT(*) as count FROM markets'),
      queryDatabase('SELECT COUNT(*) as count FROM bets'),
      queryDatabase('SELECT COALESCE(SUM(amount), 0) as total FROM bets WHERE status = $1', ['confirmed'])
    ]);

    res.json({
      totalMarkets: parseInt(markets.rows[0].count),
      totalBets: parseInt(bets.rows[0].count),
      totalVolume: parseFloat(volume.rows[0].total || 0),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch admin stats',
      details: error.message 
    });
  }
});

// Get pending markets for admin review
app.get('/api/admin/pending-markets', async (req, res) => {
  try {
    const { address } = req.query;
    
  const adminAddresses = ['DkoKjWfXRc7frJkQoVC1xL76BUBTzgmTRzm5KaQbRAyd'];
    
    if (!adminAddresses.includes(address)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const result = await queryDatabase(`
      SELECT 
        m.*,
        COUNT(b.id) as bet_count,
        COALESCE(SUM(b.amount), 0) as volume
      FROM markets m 
      LEFT JOIN bets b ON m.id = b.market_id AND b.status = 'confirmed'
      WHERE m.status = 'under_review'
      GROUP BY m.id 
      ORDER BY m.created_at ASC
    `);

    const markets = result.rows.map(row => ({
      ...row,
      total_volume: parseFloat(row.volume || 0),
      total_bets: parseInt(row.bet_count || 0),
      options: typeof row.options === 'string' ? JSON.parse(row.options) : row.options
    }));

    console.log(`Admin ${address} requested ${markets.length} pending markets`);

    res.json({ 
      markets,
      count: markets.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch pending markets',
      details: error.message 
    });
  }
});

// Approve a market
app.post('/api/admin/approve-market/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { address } = req.query;
    
  const adminAddresses = ['DkoKjWfXRc7frJkQoVC1xL76BUBTzgmTRzm5KaQbRAyd'];
    
    if (!adminAddresses.includes(address)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const result = await queryDatabase(`
      UPDATE markets 
      SET 
        status = 'active',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'under_review'
      RETURNING *
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Market not found or already processed' });
    }

    const market = result.rows[0];
    market.options = typeof market.options === 'string' ? JSON.parse(market.options) : market.options;

    console.log(`Market ${id} approved by admin ${address}: "${market.title}"`);

    res.json({ 
      market,
      message: 'Market approved successfully'
    });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      error: 'Failed to approve market',
      details: error.message 
    });
  }
});

// Reject a market
app.post('/api/admin/reject-market/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { address } = req.query;
    const { reason } = req.body;
    
  const adminAddresses = ['DkoKjWfXRc7frJkQoVC1xL76BUBTzgmTRzm5KaQbRAyd'];
    
    if (!adminAddresses.includes(address)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const result = await queryDatabase(`
      UPDATE markets 
      SET 
        status = 'rejected',
        updated_at = CURRENT_TIMESTAMP,
        metadata = COALESCE(metadata, '{}') || $2::jsonb
      WHERE id = $1 AND status = 'under_review'
      RETURNING *
    `, [id, JSON.stringify({ rejection_reason: reason || 'Violated platform guidelines' })]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Market not found or already processed' });
    }

    const market = result.rows[0];
    market.options = typeof market.options === 'string' ? JSON.parse(market.options) : market.options;

    console.log(`Market ${id} rejected by admin ${address}: "${market.title}" - Reason: ${reason}`);

    res.json({ 
      market,
      message: 'Market rejected successfully'
    });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      error: 'Failed to reject market',
      details: error.message 
    });
  }
});

// Update market odds
app.post('/api/admin/update-odds/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { address } = req.query;
    const { odds } = req.body;
    
  const adminAddresses = ['DkoKjWfXRc7frJkQoVC1xL76BUBTzgmTRzm5KaQbRAyd'];
    
    if (!adminAddresses.includes(address)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Validate odds
    if (!Array.isArray(odds) || odds.length === 0) {
      return res.status(400).json({ error: 'Invalid odds format - must be array' });
    }

    for (const odd of odds) {
      if (typeof odd !== 'number' || odd < 1.1) {
        return res.status(400).json({ error: 'All odds must be numbers >= 1.1' });
      }
    }

    const result = await queryDatabase(`
      UPDATE markets 
      SET 
        metadata = COALESCE(metadata, '{}') || $2::jsonb,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [id, JSON.stringify({ admin_odds: odds })]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Market not found' });
    }

    const market = result.rows[0];
    market.options = typeof market.options === 'string' ? JSON.parse(market.options) : market.options;

    console.log(`Market ${id} odds updated by admin ${address}: [${odds.join(', ')}]`);

    res.json({ 
      market,
      message: 'Odds updated successfully'
    });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      error: 'Failed to update odds',
      details: error.message 
    });
  }
});

// --- Comments API ---
// Admin: Delete any comment by comment ID
app.delete('/api/admin/comments/:commentId', async (req, res) => {
  const { commentId } = req.params;
  const { address } = req.query;
  const adminAddresses = ['DkoKjWfXRc7frJkQoVC1xL76BUBTzgmTRzm5KaQbRAyd'];
  if (!adminAddresses.includes(address)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const result = await pool.query('DELETE FROM comments WHERE id = $1 RETURNING *', [commentId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    res.json({ message: 'Comment deleted', comment: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Cancel a bet (user can cancel their own pending bet)
app.post('/api/cancel', async (req, res) => {
  const { betId, user_address } = req.body;
  if (!betId || !user_address) {
    return res.status(400).json({ error: 'Missing betId or user_address' });
  }
  try {
    // Only allow cancel if bet is still pending and belongs to user
    const betResult = await pool.query(
      `SELECT * FROM bets WHERE id = $1 AND bettor_address = $2 AND status = 'pending'`,
      [betId, user_address]
    );
    if (betResult.rows.length === 0) {
      return res.status(403).json({ error: 'No pending bet found for this user' });
    }
    // Mark as cancelled
    const result = await pool.query(
      `UPDATE bets SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
      [betId]
    );
    res.json({ message: 'Bet cancelled', bet: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Admin: Delete any comment by comment ID
app.delete('/api/admin/comments/:commentId', async (req, res) => {
  const { commentId } = req.params;
  const { address } = req.query;
  const adminAddresses = ['DkoKjWfXRc7frJkQoVC1xL76BUBTzgmTRzm5KaQbRAyd'];
  if (!adminAddresses.includes(address)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const result = await pool.query('DELETE FROM comments WHERE id = $1 RETURNING *', [commentId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    res.json({ message: 'Comment deleted', comment: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Add a comment to a bet (only if user has a confirmed bet with matching wallet)
app.post('/api/bets/:betId/comments', async (req, res) => {
  const { betId } = req.params;
  const { user_address, comment_text } = req.body;
  if (!user_address || !comment_text) {
    return res.status(400).json({ error: 'Missing user_address or comment_text' });
  }
  try {
    // Check if the bet exists and belongs to the user (confirmed status)
    const betResult = await pool.query(
      `SELECT * FROM bets WHERE id = $1 AND bettor_address = $2 AND status = 'confirmed'`,
      [betId, user_address]
    );
    if (betResult.rows.length === 0) {
      return res.status(403).json({ error: 'You must have a confirmed bet with this wallet to comment.' });
    }
    const result = await pool.query(
      `INSERT INTO comments (bet_id, user_address, comment_text) VALUES ($1, $2, $3) RETURNING *`,
      [betId, user_address, comment_text]
    );
    res.json({ comment: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all comments for a bet
app.get('/api/bets/:betId/comments', async (req, res) => {
  const { betId } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM comments WHERE bet_id = $1 ORDER BY created_at ASC`,
      [betId]
    );
    res.json({ comments: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: error.message,
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Route not found',
    path: req.originalUrl,
    timestamp: new Date().toISOString()
  });
});

// Start server
async function startServer() {
  try {
    // Initialize database
    await initializeDatabase();
    
    // Start HTTP server
    app.listen(PORT, async () => {
      console.log('Solymarket Backend Server Started');
      console.log(`Server running on port ${PORT}`);
      console.log(`API accessible at http://localhost:${PORT}/api`);
      console.log(`Database: solymarket_db (SSL disabled)`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log('Health check: GET /api/health');
      console.log('Admin endpoints: /api/admin/* (requires admin wallet)');
      console.log('=====================================');
      // Startup diagnostics
      try {
        await pool.query('SELECT 1');
        console.log('Startup diagnostics: Database connection OK');
      } catch (e) {
        console.error('Startup diagnostics: Database connection ERROR', e.message);
      }
      // Test health endpoint
      const http = require('http');
      const options = {
        hostname: 'localhost',
        port: PORT,
        path: '/api/health',
        method: 'GET',
        timeout: 2000
      };
      const req = http.request(options, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          console.log('Startup diagnostics: Health endpoint response:', data);
        });
      });
      req.on('error', err => {
        console.error('Startup diagnostics: Health endpoint error:', err.message);
      });
      req.end();
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down server...');
  await pool.end();
  console.log('Database connections closed');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  await pool.end();
  console.log('Database connections closed');
  process.exit(0);
});

// Serve static frontend from /public
app.use(express.static(path.join(__dirname, 'public')));

// Handle favicon.ico requests to avoid errors
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Fallback to index.html for SPA (after all API routes)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
startServer();

// Solana RPC Proxy endpoint
app.post('/api/solana-proxy', async (req, res) => {
  try {
    const { method, params } = req.body;
    if (!method) return res.status(400).json({ error: 'Missing RPC method' });
    // Forward the request to the Solana RPC endpoint using the API key from .env
    const rpcUrl = process.env.SOLANA_RPC_URL;
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Solana proxy error:', error);
    res.status(500).json({ error: 'Solana proxy failed', details: error.message });
  }
});
