# SSO & Analytics System (Cloudflare Workers)

This is a unified Single Sign-On (SSO) and Analytics system built on Cloudflare Workers, D1, and Workers Analytics Engine. It provides centralized authentication and usage tracking for multiple web applications.

## Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed.
- A Cloudflare account.

## 1. Initialization

### Create the D1 Database

First, create a new D1 database:

```bash
npx wrangler d1 create sso-db
```

Update your `wrangler.toml` with the generated `database_id`.

### Apply the Schema

Run the following command to initialize the database tables:

```bash
# For local development
npx wrangler d1 execute sso-db --local --file=./schema.sql

# For production
npx wrangler d1 execute sso-db --file=./schema.sql
```

### Deploy the Worker

Deploy the worker to Cloudflare:

```bash
npx wrangler deploy
```

## 2. Admin API Usage

The Admin API is protected by Basic Auth. Use the `ADMIN_USERNAME` and `ADMIN_PASSWORD` defined in your `wrangler.toml` (or set them as secrets via `wrangler secret put`).

### Apps Management

**Create an App:**
```bash
curl -X POST https://<your-worker-url>/admin/apps \
  -u admin:supersecretpassword \
  -H "Content-Type: application/json" \
  -d '{"app_id": "english-assistant", "app_name": "English Assistant", "callback_url": "https://app.example.com/callback", "secret_key": "app-secret"}'
```

**List Apps:**
```bash
curl https://<your-worker-url>/admin/apps -u admin:supersecretpassword
```

### User Management

**Create a User:**
```bash
curl -X POST https://<your-worker-url>/admin/users \
  -u admin:supersecretpassword \
  -H "Content-Type: application/json" \
  -d '{"username": "johndoe", "name": "John Doe", "password": "securepassword123", "cookie_expiry_days": 7}'
```

**Pause/Continue a User:**
```bash
# Pause
curl -X POST https://<your-worker-url>/admin/users/<uuid>/pause -u admin:supersecretpassword

# Continue
curl -X POST https://<your-worker-url>/admin/users/<uuid>/continue -u admin:supersecretpassword
```

### Permissions Management

**Assign an App to a User:**
```bash
curl -X POST https://<your-worker-url>/admin/permissions \
  -u admin:supersecretpassword \
  -H "Content-Type: application/json" \
  -d '{"uuid": "<user_uuid>", "app_id": "english-assistant"}'
```

## 3. Sub-App Integration Guide

### User Login

Sub-apps should redirect users to a centralized login page (or handle it via API).

**Endpoint:** `POST /login`
**Payload:** `{"username": "johndoe", "password": "securepassword123"}`

**Success Response:**
```json
{
  "token": "<jwt_string>",
  "jwt": "<jwt_string>",
  "uuid": "<user_uuid>",
  "user_id": 1,
  "name": "John Doe",
  "timestamp": 1709390000
}
```

### Token Verification

When a user accesses a sub-app, the sub-app should verify the token and check if the user has permission for that specific app.

**Endpoint:** `GET /api/verify?app_id=english-assistant`
**Headers:** `Authorization: Bearer <jwt_string>`

If the user is paused by an admin, this endpoint will return a `403 Forbidden` error, and the sub-app should log the user out immediately.

### Analytics Tracking

Sub-apps can send usage data to the centralized Analytics Engine.

**Endpoint:** `POST /api/track`
**Payload:**
```json
{
  "app_id": "english-assistant",
  "uuid": "<user_uuid>",
  "event_type": "page_view",
  "duration_seconds": 120
}
```

The system automatically records the user's country (via Cloudflare headers) and parses the `User-Agent` to determine the device type and browser.
