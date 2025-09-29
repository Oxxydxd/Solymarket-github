{
  "name": "solymarket-backend",
  "version": "1.0.0",
  "description": "Backend API for Solymarket prediction markets",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js",
    "db:migrate": "node scripts/migrate.js",
    "db:seed": "node scripts/seed.js",
    "test": "jest",
    "test:watch": "jest --watch"
  },
  "dependencies": {
    "@solana/web3.js": "^1.87.6",
    "bs58": "^5.0.0",
    "cloudinary": "^1.41.0",
    "cors": "^2.8.5",
    "dotenv": "^16.6.1",
    "express": "^4.18.2",
    "express-rate-limit": "^7.1.5",
    "helmet": "^7.1.0",
    "multer": "^1.4.5-lts.1",
    "node-fetch": "^3.3.2",
    "pg": "^8.11.3",
    "tweetnacl": "^1.0.3"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "nodemon": "^3.0.2",
    "supertest": "^6.3.3"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "keywords": [
    "solana",
    "prediction-markets",
    "blockchain",
    "defi"
  ],
  "author": "Your Name",
  "license": "MIT"
}
