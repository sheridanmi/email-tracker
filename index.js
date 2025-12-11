const express = require('express');
const cors = require('cors');
const initSqlJs = require('sql.js');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Database will be initialized async
let db;

// Initialize SQL.js and create tables
async function initDatabase() {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  
  db.run(`
    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY,
      subject TEXT,
      recipient TEXT,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      user_email TEXT
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS opens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email_id TEXT,
      opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip_address TEXT,
      user_agent TEXT
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY,
      email_id TEXT,
      original_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id TEXT,
      clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip_address TEXT,
      user_agent TEXT
    )
  `);
  
  console.log('Database initialized!');
}

// Middleware
app.use(cors());
app.use(express.json());

// 1x1 transparent PNG pixel
const TRACKING_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// ============================================
// TRACKING ENDPOINTS
// ============================================

// Tracking Pixel - logs when email is opened
app.get('/t/:emailId.png', (req, res) => {
  const { emailId } = req.params;
  
  try {
    db.run(
      `INSERT INTO opens (email_id, ip_address, user_agent) VALUES (?, ?, ?)`,
      [emailId, req.headers['x-forwarded-for'] || req.ip, req.headers['user-agent'] || 'Unknown']
    );
  } catch (err) {
    console.error('Error logging open:', err);
  }

  res.set({
    'Content-Type': 'image/png',
    'Content-Length': TRACKING_PIXEL.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.send(TRACKING_PIXEL);
});

// Link Click Tracking
app.get('/c/:linkId', (req, res) => {
  const { linkId } = req.params;

  try {
    const result = db.exec(`SELECT original_url FROM links WHERE id = '${linkId}'`);
    
    if (!result.length || !result[0].values.length) {
      return res.status(404).send('Link not found');
    }
    
    const originalUrl = result[0].values[0][0];

    db.run(
      `INSERT INTO clicks (link_id, ip_address, user_agent) VALUES (?, ?, ?)`,
      [linkId, req.headers['x-forwarded-for'] || req.ip, req.headers['user-agent'] || 'Unknown']
    );

    res.redirect(302, originalUrl);
  } catch (err) {
    console.error('Error processing click:', err);
    res.status(500).send('Error processing request');
  }
});

// ============================================
// API ENDPOINTS
// ============================================

// Register a new tracked email
app.post('/api/emails', (req, res) => {
  const { subject, recipient, userEmail } = req.body;
  const emailId = crypto.randomBytes(8).toString('hex');

  try {
    db.run(
      `INSERT INTO emails (id, subject, recipient, user_email) VALUES (?, ?, ?, ?)`,
      [emailId, subject, recipient, userEmail]
    );

    res.json({
      emailId,
      trackingPixel: `${getBaseUrl(req)}/t/${emailId}.png`
    });
  } catch (err) {
    console.error('Error creating email:', err);
    res.status(500).json({ error: 'Failed to create email' });
  }
});

// Register a tracked link
app.post('/api/links', (req, res) => {
  const { emailId, originalUrl } = req.body;
  const linkId = crypto.randomBytes(6).toString('hex');

  try {
    db.run(
      `INSERT INTO links (id, email_id, original_url) VALUES (?, ?, ?)`,
      [linkId, emailId, originalUrl]
    );

    res.json({
      linkId,
      trackedUrl: `${getBaseUrl(req)}/c/${linkId}`
    });
  } catch (err) {
    console.error('Error creating link:', err);
    res.status(500).json({ error: 'Failed to create link' });
  }
});

// Get all emails for a user
app.get('/api/emails', (req, res) => {
  const { userEmail } = req.query;

  try {
    const result = db.exec(`
      SELECT 
        e.id,
        e.subject,
        e.recipient,
        e.sent_at,
        (SELECT COUNT(*) FROM opens WHERE email_id = e.id) as open_count,
        (SELECT MAX(opened_at) FROM opens WHERE email_id = e.id) as last_opened,
        (SELECT COUNT(*) FROM clicks c JOIN links l ON c.link_id = l.id WHERE l.email_id = e.id) as click_count
      FROM emails e
      WHERE e.user_email = '${userEmail}'
      ORDER BY e.sent_at DESC
      LIMIT 100
    `);

    if (!result.length) {
      return res.json([]);
    }

    const columns = result[0].columns;
    const emails = result[0].values.map(row => {
      const obj = {};
      columns.forEach((col, i) => obj[col] = row[i]);
      return obj;
    });

    res.json(emails);
  } catch (err) {
    console.error('Error fetching emails:', err);
    res.status(500).json({ error: 'Failed to fetch emails' });
  }
});

// Get detailed stats for one email
app.get('/api/emails/:emailId', (req, res) => {
  const { emailId } = req.params;

  try {
    // Get email
    const emailResult = db.exec(`SELECT * FROM emails WHERE id = '${emailId}'`);
    
    if (!emailResult.length || !emailResult[0].values.length) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const emailColumns = emailResult[0].columns;
    const emailRow = emailResult[0].values[0];
    const email = {};
    emailColumns.forEach((col, i) => email[col] = emailRow[i]);

    // Get opens
    const opensResult = db.exec(`
      SELECT opened_at, ip_address, user_agent 
      FROM opens WHERE email_id = '${emailId}' 
      ORDER BY opened_at DESC
    `);
    
    const opens = opensResult.length ? opensResult[0].values.map(row => ({
      opened_at: row[0],
      ip_address: row[1],
      user_agent: row[2]
    })) : [];

    // Get links
    const linksResult = db.exec(`
      SELECT l.id, l.original_url,
        (SELECT COUNT(*) FROM clicks WHERE link_id = l.id) as click_count
      FROM links l WHERE l.email_id = '${emailId}'
    `);
    
    const links = linksResult.length ? linksResult[0].values.map(row => ({
      id: row[0],
      original_url: row[1],
      click_count: row[2]
    })) : [];

    // Get clicks
    const clicksResult = db.exec(`
      SELECT c.clicked_at, c.ip_address, c.user_agent, l.original_url
      FROM clicks c
      JOIN links l ON c.link_id = l.id
      WHERE l.email_id = '${emailId}'
      ORDER BY c.clicked_at DESC
    `);
    
    const clicks = clicksResult.length ? clicksResult[0].values.map(row => ({
      clicked_at: row[0],
      ip_address: row[1],
      user_agent: row[2],
      original_url: row[3]
    })) : [];

    const uniqueOpenIps = new Set(opens.map(o => o.ip_address));
    const uniqueClickIps = new Set(clicks.map(c => c.ip_address));

    res.json({
      ...email,
      opens,
      links,
      clicks,
      stats: {
        totalOpens: opens.length,
        uniqueOpens: uniqueOpenIps.size,
        totalClicks: clicks.length,
        uniqueClicks: uniqueClickIps.size
      }
    });
  } catch (err) {
    console.error('Error fetching email details:', err);
    res.status(500).json({ error: 'Failed to fetch email details' });
  }
});

// Get aggregate stats
app.get('/api/stats', (req, res) => {
  const { userEmail } = req.query;

  try {
    const emailsResult = db.exec(`SELECT COUNT(*) FROM emails WHERE user_email = '${userEmail}'`);
    const totalEmails = emailsResult.length ? emailsResult[0].values[0][0] : 0;

    const opensResult = db.exec(`
      SELECT COUNT(*) FROM opens o 
      JOIN emails e ON o.email_id = e.id 
      WHERE e.user_email = '${userEmail}'
    `);
    const totalOpens = opensResult.length ? opensResult[0].values[0][0] : 0;

    const clicksResult = db.exec(`
      SELECT COUNT(*) FROM clicks c 
      JOIN links l ON c.link_id = l.id 
      JOIN emails e ON l.email_id = e.id 
      WHERE e.user_email = '${userEmail}'
    `);
    const totalClicks = clicksResult.length ? clicksResult[0].values[0][0] : 0;

    res.json({
      total_emails: totalEmails,
      total_opens: totalOpens,
      total_clicks: totalClicks
    });
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

function getBaseUrl(req) {
  return process.env.RENDER_EXTERNAL_URL || 
         process.env.BASE_URL || 
         `${req.protocol}://${req.get('host')}`;
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Home page
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Email Tracker</title></head>
      <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
        <h1>📧 Email Tracker Server</h1>
        <p style="color: green; font-size: 1.2em;">✅ Your server is running!</p>
        <p>Now set up the Gmail add-on to start tracking emails.</p>
        <hr>
        <p><strong>Note:</strong> Data is stored in memory and will reset when the server restarts. This is normal for the free tier!</p>
      </body>
    </html>
  `);
});

// Start server after database is ready
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`📧 Email Tracker running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
