# Sycord Deployment Server - API Documentation

This document provides detailed information about the deployment API endpoints, including request/response formats, expected parameters, and what the API provides.

## Table of Contents

1. [Database Structure](#database-structure)
2. [API Endpoints](#api-endpoints)
   - [Deploy by Username and Repo ID](#deploy-by-username-and-repo-id)
   - [List All Repositories](#list-all-repositories)
   - [List User Repositories](#list-user-repositories)
   - [Get Deployment Domain by Repo ID](#get-deployment-domain-by-repo-id)
   - [Health Check](#health-check)
   - [Get Recent Logs](#get-recent-logs)
3. [Error Handling](#error-handling)
4. [Deployment Flow](#deployment-flow)

---

## Database Structure

The API expects repositories to be stored in MongoDB with the following structure:

**Database:** `main`  
**Collection:** `users`  
**Path:** `main > users > {username} > git_connection > {repo_id: {repo document}}`

### User Document Schema

```json
{
  "_id": ObjectId("..."),
  "username": "MDavidka",
  "git_connection": {
    "1126661988": {
      "username": "MDavidka",
      "repo_id": "1126661988",
      "git_url": "https://github.com/MDavidka/tesf",
      "git_token": "ghp_xxxxxxxxxxxxxxxxxxxx",
      "repo_name": "tesf",
      "project_id": "6957a3fb538e5f68b68b58f7",
      "deployed_at": {
        "$date": "2026-01-02T10:56:42.117Z"
      }
    }
  }
}
```

Note: `git_connection` is a **dictionary/object** where keys are the `repo_id` values and values are the repository documents.

### Field Descriptions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `username` | string | Yes | The username of the repository owner in the system |
| `repo_id` | string | Yes | A unique numeric identifier for the repository (e.g., "1126661988") |
| `git_url` | string | Yes | The GitHub repository URL in HTTPS format (e.g., `https://github.com/owner/repo`) |
| `git_token` | string | Yes | GitHub personal access token with `repo` scope for accessing the repository |
| `repo_name` | string | No | The repository name (optional, can be parsed from git_url) |
| `project_id` | string | No | The Cloudflare project ID after deployment |
| `deployed_at` | date | No | Timestamp of the last deployment |

---

## API Endpoints

### Deploy by Repo ID

**Endpoint:** `GET/POST /api/deploy/{repo_id}`

This is the primary deployment endpoint that triggers a deployment from a GitHub repository to Cloudflare Pages using only the repository ID.

#### URL Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repo_id` | string | Yes | Numeric repository identifier |

#### What the API Expects

1. **Valid `repo_id`** - Must be a numeric string
2. **Repository document** - Must contain `git_url` and `git_token`

#### Request Examples

```bash
# Using GET request
curl "http://localhost:5000/api/deploy/1126661988"

# Using POST request
curl -X POST "http://localhost:5000/api/deploy/1126661988"

# Using POST with headers (no body required)
curl -X POST "http://localhost:5000/api/deploy/1126661988" \
  -H "Accept: application/json"
```

#### What the API Provides

The API performs the following actions:

1. **Validation**
   - Validates that `repo_id` is a numeric string
   - Verifies the repository entry exists in `git_connection`

2. **Repository Retrieval**
   - Fetches `git_url` and `git_token` from the database
   - Parses the `git_url` to extract owner and repository name

3. **GitHub Download**
   - Downloads the repository as a ZIP archive using the GitHub API
   - Authenticates using the `git_token`
   - Tries multiple branches: specified branch → `main` → `master`

4. **Cloudflare Deployment**
   - Creates a Cloudflare Pages project (if it doesn't exist)
   - Deploys the repository files using Wrangler CLI
   - Returns the live deployment URL

#### Response Format (Success)

```json
{
  "success": true,
  "message": "Deployment successful! Project: tesf",
  "project_name": "tesf",
  "url": "https://tesf.pages.dev",
  "username": "MDavidka",
  "repo_id": "1126661988",
  "output": "Wrangler CLI output..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Always `true` for successful deployments |
| `message` | string | Human-readable success message |
| `project_name` | string | Sanitized Cloudflare project name |
| `url` | string | Live deployment URL on Cloudflare Pages |
| `username` | string | The username that was provided |
| `repo_id` | string | The repo_id that was provided |
| `output` | string | Raw output from Wrangler CLI |

#### Response Format (Error)

```json
{
  "success": false,
  "message": "Error description",
  "error": "Detailed error information (optional)"
}
```

#### Error Codes

| HTTP Status | Message | Cause |
|-------------|---------|-------|
| 400 | Invalid repo_id format. Expected numeric identifier. | `repo_id` is not numeric |
| 404 | Repository {repo_id} not found for user {username} | User or repository doesn't exist |
| 404 | GitHub token (git_token) not found for repository | Missing `git_token` in database |
| 404 | Git URL (git_url) not found for repository | Missing `git_url` in database |
| 400 | Could not parse git_url: {url} | Invalid GitHub URL format |
| 500 | Failed to download repository from GitHub | GitHub API error or invalid token |
| 500 | Deployment failed | Cloudflare/Wrangler deployment error |

---

### Get Deployment Domain by Repo ID

**Endpoint:** `GET /api/deploy/{repo_id}/domain`

Retrieve the Cloudflare Pages domain for a deployed repository using its `repo_id`.

#### Request

```bash
curl "http://localhost:5000/api/deploy/1126661988/domain"
```

#### Response (Success)

```json
{
  "success": true,
  "repo_id": "1126661988",
  "project_name": "tesf",
  "domain": "https://tesf.pages.dev",
  "username": "MDavidka",
  "git_url": "https://github.com/MDavidka/tesf",
  "owner": "MDavidka",
  "repo_name": "tesf"
}
```

#### Response (Error)

```json
{
  "success": false,
  "message": "Invalid repo_id format. Expected numeric identifier."
}
```

#### Error Codes

| HTTP Status | Message | Cause |
|-------------|---------|-------|
| 400 | Invalid repo_id format. Expected numeric identifier. | `repo_id` is not numeric |
| 404 | Repository {repo_id} not found | repo_id not present in git_connection |
| 404 | Repository name not found for repository | Missing `repo_name` and unparsable `git_url` |
| 500 | Failed to retrieve deployment domain | Unexpected server error |

---

### List All Repositories

**Endpoint:** `GET /api/repos`

Fetches all repositories from all users in the database.

#### Request

```bash
curl "http://localhost:5000/api/repos"
```

#### What the API Provides

- Retrieves all user documents with `git_connection` dictionaries
- Parses each `git_url` to extract owner and repository name
- Returns a flattened list of all repositories

#### Response Format

```json
{
  "success": true,
  "repositories": [
    {
      "username": "MDavidka",
      "repo_id": "1126661988",
      "git_url": "https://github.com/MDavidka/tesf",
      "name": "tesf",
      "owner": "MDavidka",
      "full_name": "MDavidka/tesf"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `username` | string | User who owns this repository entry |
| `repo_id` | string | Repository identifier |
| `git_url` | string | Full GitHub repository URL |
| `name` | string | Repository name (from repo_name field or parsed from git_url) |
| `owner` | string | GitHub owner/organization (parsed from git_url) |
| `full_name` | string | Full repository path (owner/repo) |

---

### List User Repositories

**Endpoint:** `GET /api/repos/{username}`

Fetches all repositories for a specific user.

#### URL Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `username` | string | Yes | The username to fetch repositories for |

#### Request

```bash
curl "http://localhost:5000/api/repos/MDavidka"
```

#### Response Format

```json
{
  "success": true,
  "username": "MDavidka",
  "repositories": [
    {
      "repo_id": "1126661988",
      "git_url": "https://github.com/MDavidka/tesf",
      "name": "tesf",
      "owner": "MDavidka",
      "full_name": "MDavidka/tesf"
    }
  ]
}
```

---

### Health Check

**Endpoint:** `GET /api/health`

Simple health check to verify the server is running.

#### Request

```bash
curl "http://localhost:5000/api/health"
```

#### Response Format

```json
{
  "status": "healthy",
  "service": "M1 Instance - Sycord Deployment Server",
  "instance": "M1"
}
```

---

### Get Recent Logs (System Console)

**Endpoint:** `GET /api/logs`

This endpoint powers the "System Console" in the frontend. It provides access to the server's ephemeral, in-memory logs, which are tagged by project context to allow for real-time deployment monitoring.

#### What to Use

- **Endpoint URL:** `http://localhost:5000/api/logs`
- **Method:** `GET`
- **Clients:** Browser (via `fetch`), CLI (via `curl`), or any HTTP client.

#### Query Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `project_id` | string | No | Server ID | **The Filter Tag.** During a deployment, this should be set to the **`repo_id`** of the repository being deployed. This filters the log stream to show only logs relevant to that specific deployment process. If omitted, it returns logs for the main server instance. |
| `limit` | integer | No | `200` | **The Buffer Size.** Specifies the number of most recent log lines to retrieve. The maximum allowed value is clamped to the server's buffer size (typically 500). |

#### What Will It Get (Response)

The API returns a JSON object containing the status, the context tag used, and an array of log strings.

```json
{
  "success": true,
  "project_id": "1126661988",
  "logs": [
    "2026-01-06 14:44:22,727 [INFO] [1126661988] Starting deployment for repo 1126661988",
    "2026-01-06 14:44:22,728 [INFO] [1126661988] Created temporary directory: /tmp/github_repo_x82a",
    "2026-01-06 14:44:25,100 [WARNING] [1126661988] npm warn: deprecated dependency found",
    "2026-01-06 14:44:40,030 [ERROR] [1126661988] Deployment failed: verify credentials"
  ]
}
```

#### What Is What (Fields)

- **`success`** (`boolean`): Indicates if the log retrieval was successful.
- **`project_id`** (`string`): The tag used to filter these logs.
    - When you pass `?project_id=12345`, this field will be `12345`.
    - This confirms you are looking at the specific log stream you requested.
- **`logs`** (`array of strings`): The actual log lines.
    - **Format:** `YYYY-MM-DD HH:MM:SS,ms [LEVEL] [TAG] MESSAGE`
    - **Parsing:** The frontend uses the `[LEVEL]` tag (e.g., `[ERROR]`, `[WARNING]`) to apply CSS coloring (red for errors, yellow for warnings).
    - **Order:** Oldest to newest (append-only).

#### How It Works Internally

1. **Context Injection:** When a deployment starts (e.g., via `/api/deploy/{repo_id}`), the server sets a thread-local context variable `project_tag` to the `repo_id`.
2. **Log Filtering:** A custom `logging.Filter` injects this tag into every log record generated during the request.
3. **In-Memory Storage:** Logs are written to an `InMemoryLogHandler` which stores them in a circular buffer (deque). This is **ephemeral**—restarting the server clears the logs.
4. **Retrieval:** When you call `/api/logs?project_id={repo_id}`, the server scans this memory buffer and returns only the lines where `[TAG]` matches your `repo_id`.

#### Usage Example: Real-time Monitoring

To monitor a deployment for repository `1126661988`:

1. **Start Deployment:**
   ```bash
   curl -X POST http://localhost:5000/api/deploy/1126661988
   ```

2. **Poll Logs (Loop):**
   ```bash
   # Poll every 2 seconds
   curl "http://localhost:5000/api/logs?project_id=1126661988"
   ```

3. **Frontend Implementation:**
   The frontend uses `setInterval` to fetch this endpoint every 2 seconds. It clears the console window and re-renders the `logs` array. Styling is applied based on string content (e.g., `if (log.includes('[ERROR]')) ...`).

---

## Error Handling

All error responses follow this format:

```json
{
  "success": false,
  "message": "Human-readable error message",
  "error": "Detailed technical error (when available)"
}
```

### Common HTTP Status Codes

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 400 | Bad Request - Invalid parameters |
| 404 | Not Found - Resource doesn't exist |
| 500 | Server Error - Internal processing error |

---

## Deployment Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    DEPLOYMENT FLOW                               │
└─────────────────────────────────────────────────────────────────┘

1. REQUEST
   ┌─────────────────┐
   │ Client Request  │ → GET/POST /api/deploy/{repo_id}
   └─────────────────┘

2. VALIDATION
   ┌─────────────────┐
   │ Validate Input  │ → Check repo_id is numeric
   └─────────────────┘

3. DATABASE LOOKUP
   ┌─────────────────┐
   │ MongoDB Query   │ → Find repo in git_connection[repo_id] across users
   └─────────────────┘
         │
         ▼
   ┌─────────────────┐
   │ Retrieved Data  │ → git_url, git_token
   └─────────────────┘

4. GITHUB DOWNLOAD
   ┌─────────────────┐
   │ Parse git_url   │ → Extract owner/repo
   └─────────────────┘
         │
         ▼
   ┌─────────────────┐
   │ Download ZIP    │ → GitHub API with git_token
   └─────────────────┘

5. CLOUDFLARE DEPLOYMENT
   ┌─────────────────┐
   │ Create Project  │ → Cloudflare API (if needed)
   └─────────────────┘
         │
         ▼
   ┌─────────────────┐
   │ Deploy Files    │ → wrangler pages deploy
   └─────────────────┘

6. RESPONSE
   ┌─────────────────┐
   │ Return Result   │ → success, url, project_name
   └─────────────────┘
```

---

## Example Usage

### Complete Deployment Example

```bash
# 1. Check available repositories
curl http://localhost:5000/api/repos

# 2. Deploy a specific repository
curl -X POST http://localhost:5000/api/deploy/1126661988

# 3. Check deployment result
# Response:
# {
#   "success": true,
#   "message": "Deployment successful! Project: tesf",
#   "url": "https://tesf.pages.dev",
#   ...
# }
```

### Using with JavaScript

```javascript
// Fetch repositories
const reposResponse = await fetch('/api/repos');
const { repositories } = await reposResponse.json();

// Deploy a repository
const deployResponse = await fetch(`/api/deploy/${repo_id}`, {
  method: 'POST'
});
const result = await deployResponse.json();

if (result.success) {
  console.log(`Deployed to: ${result.url}`);
}
```

---

## Notes

1. **repo_id Format**: The `repo_id` must be a numeric string. This is validated on every deploy request.

2. **git_connection Structure**: `git_connection` is a dictionary where keys are `repo_id` values and values are the repository documents.

3. **git_url Format**: The API supports GitHub URLs in these formats:
   - `https://github.com/owner/repo`
   - `https://github.com/owner/repo.git`
   - `git@github.com:owner/repo.git`

4. **git_token Permissions**: The GitHub token must have `repo` scope to access private repositories.

5. **Cloudflare Project Names**: Repository names are sanitized for Cloudflare (lowercase, alphanumeric and hyphens only, max 63 characters).
