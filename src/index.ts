import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { cors } from 'hono/cors';
import { hashPassword, generateSalt, verifyPassword, generateJWT, verifyJWT } from './auth';

type Bindings = {
  DB: D1Database;
  ANALYTICS: AnalyticsEngineDataset;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  JWT_SECRET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors());

// --- Public Routes ---

// Login
app.post('/login', async (c) => {
  const { username, password } = await c.req.json();
  if (!username || !password) {
    return c.json({ error: 'Username and password required' }, 400);
  }

  const user: any = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  if (!user) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  if (user.status === 'paused') {
    return c.json({ error: 'Account is paused' }, 403);
  }

  const isValid = await verifyPassword(password, user.password_salt, user.password_hash);
  if (!isValid) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const payload = {
    uuid: user.uuid,
    user_id: user.user_id,
    name: user.name,
    status: user.status
  };

  const token = await generateJWT(payload, c.env.JWT_SECRET, user.cookie_expiry_days);

  return c.json({
    token: token,
    jwt: token,
    uuid: user.uuid,
    user_id: user.user_id,
    name: user.name,
    timestamp: Math.floor(Date.now() / 1000)
  });
});

// Verify Token & App Permission
app.get('/api/verify', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid token' }, 401);
  }

  const token = authHeader.split(' ')[1];
  const appId = c.req.query('app_id');

  try {
    const payload = await verifyJWT(token, c.env.JWT_SECRET);
    
    // Check if user is active in DB (crucial for pause/continue)
    const user: any = await c.env.DB.prepare('SELECT status FROM users WHERE uuid = ?').bind(payload.uuid).first();
    if (!user || user.status !== 'active') {
      return c.json({ error: 'User is paused or not found' }, 403);
    }

    // Check app permission if app_id is provided
    if (appId) {
      const permission = await c.env.DB.prepare('SELECT * FROM user_apps WHERE uuid = ? AND app_id = ?')
        .bind(payload.uuid, appId).first();
      if (!permission) {
        return c.json({ error: 'No permission for this app' }, 403);
      }
    }

    return c.json({ valid: true, user: payload });
  } catch (e) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

// Track Analytics
app.post('/api/track', async (c) => {
  const { app_id, uuid, event_type, duration_seconds } = await c.req.json();
  
  if (!app_id || !uuid || !event_type) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  const country = c.req.raw.cf?.country || 'Unknown';
  const userAgent = c.req.header('User-Agent') || '';
  
  let deviceType = 'Desktop';
  if (/Mobile|Android|iP(hone|od|ad)/i.test(userAgent)) {
    deviceType = 'Mobile';
  }

  let browser = 'Other';
  if (/Chrome/i.test(userAgent)) browser = 'Chrome';
  else if (/Safari/i.test(userAgent)) browser = 'Safari';
  else if (/Firefox/i.test(userAgent)) browser = 'Firefox';
  else if (/Edge/i.test(userAgent)) browser = 'Edge';

  // Write to Analytics Engine
  c.env.ANALYTICS.writeDataPoint({
    blobs: [app_id, uuid, event_type, country as string, deviceType, browser],
    doubles: [duration_seconds || 0],
    indexes: [app_id]
  });

  return c.json({ success: true });
});


// --- Admin Routes ---

// Apply basic auth to all /admin/* routes
app.use('/admin/*', async (c, next) => {
  const auth = basicAuth({
    username: c.env.ADMIN_USERNAME,
    password: c.env.ADMIN_PASSWORD,
  });
  return auth(c, next);
});

// Users CRUD
app.get('/admin/users', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT user_id, uuid, username, name, status, cookie_expiry_days, created_at FROM users').all();
  return c.json(results);
});

app.post('/admin/users', async (c) => {
  const { username, name, password, cookie_expiry_days = 7 } = await c.req.json();
  const uuid = crypto.randomUUID();
  const salt = generateSalt();
  const hash = await hashPassword(password, salt);

  try {
    await c.env.DB.prepare(
      'INSERT INTO users (uuid, username, name, password_hash, password_salt, cookie_expiry_days) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(uuid, username, name, hash, salt, cookie_expiry_days).run();
    return c.json({ success: true, uuid });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

app.delete('/admin/users/:uuid', async (c) => {
  const uuid = c.req.param('uuid');
  await c.env.DB.prepare('DELETE FROM users WHERE uuid = ?').bind(uuid).run();
  return c.json({ success: true });
});

// Pause / Continue
app.post('/admin/users/:uuid/pause', async (c) => {
  const uuid = c.req.param('uuid');
  await c.env.DB.prepare("UPDATE users SET status = 'paused' WHERE uuid = ?").bind(uuid).run();
  return c.json({ success: true, status: 'paused' });
});

app.post('/admin/users/:uuid/continue', async (c) => {
  const uuid = c.req.param('uuid');
  await c.env.DB.prepare("UPDATE users SET status = 'active' WHERE uuid = ?").bind(uuid).run();
  return c.json({ success: true, status: 'active' });
});

// Apps CRUD
app.get('/admin/apps', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM apps').all();
  return c.json(results);
});

app.post('/admin/apps', async (c) => {
  const { app_id, app_name, callback_url, secret_key } = await c.req.json();
  try {
    await c.env.DB.prepare(
      'INSERT INTO apps (app_id, app_name, callback_url, secret_key) VALUES (?, ?, ?, ?)'
    ).bind(app_id, app_name, callback_url, secret_key).run();
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

app.put('/admin/apps/:app_id', async (c) => {
  const appId = c.req.param('app_id');
  const { app_name, callback_url, secret_key } = await c.req.json();
  await c.env.DB.prepare(
    'UPDATE apps SET app_name = ?, callback_url = ?, secret_key = ? WHERE app_id = ?'
  ).bind(app_name, callback_url, secret_key, appId).run();
  return c.json({ success: true });
});

app.delete('/admin/apps/:app_id', async (c) => {
  const appId = c.req.param('app_id');
  await c.env.DB.prepare('DELETE FROM apps WHERE app_id = ?').bind(appId).run();
  return c.json({ success: true });
});

// Permissions
app.post('/admin/permissions', async (c) => {
  const { uuid, app_id } = await c.req.json();
  try {
    await c.env.DB.prepare('INSERT INTO user_apps (uuid, app_id) VALUES (?, ?)').bind(uuid, app_id).run();
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

app.delete('/admin/permissions', async (c) => {
  const { uuid, app_id } = await c.req.json();
  await c.env.DB.prepare('DELETE FROM user_apps WHERE uuid = ? AND app_id = ?').bind(uuid, app_id).run();
  return c.json({ success: true });
});

// Analytics Stats
app.get('/admin/stats', async (c) => {
  // Workers Analytics Engine is queried via the Cloudflare GraphQL API.
  // This endpoint serves as a placeholder or can be implemented later by making a fetch request to the GraphQL API.
  return c.json({ 
    message: 'To query Analytics Engine data, use the Cloudflare GraphQL API with your account ID and API token.',
    docs: 'https://developers.cloudflare.com/analytics/graphql-api/'
  });
});

export default app;
