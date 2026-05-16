# server-sycord

A Flask server (M1 Instance) that automatically deploys content from GitHub repositories to Cloudflare Pages using Wrangler CLI.

![Desktop UI](https://github.com/user-attachments/assets/abaf97f9-b1e3-431c-87a0-5040112eca2f)

## Features

- 🚀 RESTful API for triggering deployments
- 🔗 GitHub integration - fetches repositories using stored GitHub tokens
- ☁️ Deploys to Cloudflare Pages using Wrangler
- 🎨 Modern dark UI with Inter font (#19191B theme)
- 📱 Mobile-optimized responsive design
- 🔄 Real-time data sync visualization
- 🔒 Environment-based configuration
- 📊 Health check endpoint

## Prerequisites

- Python 3.8 or higher
- MongoDB instance with GitHub tokens stored
- Cloudflare account with API token
- Node.js and npm (for Wrangler CLI)
- Wrangler CLI installed globally: `npm install -g wrangler`

## Quick Start

Use the auto-deploy starter script:

```bash
chmod +x starter.sh
./starter.sh
```

This script will:
1. Check and install Node.js if needed
2. Install Wrangler CLI globally
3. Set up Python virtual environment
4. Install Python dependencies
5. Start the deployment server

## Manual Installation

1. Clone the repository:
```bash
git clone https://github.com/MDavidka/server-sycord.git
cd server-sycord
```

2. Create a virtual environment:
```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

3. Install Python dependencies:
```bash
pip install -r requirements.txt
```

4. Install Wrangler CLI:
```bash
npm install -g wrangler
```

5. Configure environment variables:
```bash
cp .env.example .env
```

Edit `.env` and set your configuration:
- `MONGO_URI`: MongoDB connection string
- `MONGO_DB`: Database name (default: `main`)
- `MONGO_COLLECTION`: Collection name (default: `users`)
- `CLOUDFLARE_API_TOKEN`: Your Cloudflare API token
- `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare account ID

## MongoDB Document Structure

Git repositories are stored in MongoDB with the following structure:

**Database Structure:** `main > users > {username} > git_connection > [{repo documents}]`

Each user document in the `users` collection should have:

```json
{
  "_id": ObjectId("..."),
  "username": "user1",
  "git_connection": [
    {
      "username": "user1",
      "repo_id": "12345",
      "git_url": "https://github.com/owner/repository-name",
      "git_token": "github_personal_access_token"
    },
    {
      "username": "user1",
      "repo_id": "67890",
      "git_url": "https://github.com/owner/another-repo",
      "git_token": "github_personal_access_token"
    }
  ]
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `username` | string | The username of the user who owns the repositories |
| `repo_id` | string | A unique 5-digit identifier for the repository (e.g., "12345") |
| `git_url` | string | The GitHub repository URL (HTTPS format: `https://github.com/owner/repo`) |
| `git_token` | string | GitHub personal access token with repo access permissions |

## Usage

### Running the Server

Start the Flask server:

```bash
python app.py
```

Or use the starter script:

```bash
./starter.sh
```

The server will start on `http://localhost:5000` by default.

### Using with Gunicorn (Production)

For production, use Gunicorn:

```bash
gunicorn -w 4 -b 0.0.0.0:5000 app:app
```

### Using with Nginx as a Reverse Proxy

To route custom subdomains (e.g. `project.micro1.sycord.com`) seamlessly to your deployed projects, you should configure Nginx as a reverse proxy.

1. Install Nginx.
2. Link the provided `nginx.conf` to your Nginx sites configuration (e.g., `/etc/nginx/sites-available/sycord` and `/etc/nginx/sites-enabled/sycord`).
3. Reload Nginx (`sudo systemctl reload nginx`).

The `nginx.conf` ensures that the `Host`, `X-Real-IP`, `X-Forwarded-For`, and `X-Forwarded-Proto` headers are correctly passed to the Flask application.

## API Endpoints

### GET /api/repos

Fetch all GitHub repositories from all users in the database.

**Request:**
```bash
curl http://localhost:5000/api/repos
```

**Response:**
```json
{
  "success": true,
  "repositories": [
    {
      "username": "user1",
      "repo_id": "12345",
      "git_url": "https://github.com/owner/my-repo",
      "name": "my-repo",
      "owner": "owner",
      "full_name": "owner/my-repo"
    }
  ]
}
```

### GET /api/repos/{username}

Fetch repositories for a specific user.

**Request:**
```bash
curl http://localhost:5000/api/repos/user1
```

**Response:**
```json
{
  "success": true,
  "username": "user1",
  "repositories": [
    {
      "repo_id": "12345",
      "git_url": "https://github.com/owner/my-repo",
      "name": "my-repo",
      "owner": "owner",
      "full_name": "owner/my-repo"
    }
  ]
}
```

### GET/POST /api/deploy/{repo_id}

Triggers a deployment from a GitHub repository to Cloudflare Pages.

**URL Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `repo_id` | string | 5-digit repository identifier |

**Request:**
```bash
# Using GET
curl http://localhost:5000/api/deploy/12345

# Using POST
curl -X POST http://localhost:5000/api/deploy/12345
```

**What the API expects:**
- Valid `repo_id` (5-digit identifier) that matches a repository in a user's `git_connection` array

**What the API provides:**
1. Validates the repo_id
2. Retrieves the repository configuration (`git_url`, `git_token`) from MongoDB
3. Downloads the repository from GitHub using the `git_token` for authentication
4. Creates a Cloudflare Pages project (if it doesn't exist)
5. Deploys the repository to Cloudflare Pages using Wrangler
6. Returns the deployment result with the live URL

**Response (Success):**
```json
{
  "success": true,
  "message": "Deployment successful! Project: my-repo",
  "project_name": "my-repo",
  "url": "https://my-repo.pages.dev",
  "username": "user1",
  "repo_id": "12345",
  "output": "..."
}
```

**Response (Error - Invalid repo_id format):**
```json
{
  "success": false,
  "message": "Invalid repo_id format. Expected 5-digit identifier."
}
```

**Response (Error - Repository not found):**
```json
{
  "success": false,
  "message": "Repository 12345 not found for user user1"
}
```

**Response (Error - Missing credentials):**
```json
{
  "success": false,
  "message": "GitHub token (git_token) not found for repository"
}
```

**Response (Error - Deployment failed):**
```json
{
  "success": false,
  "message": "Deployment failed",
  "error": "Error details..."
}
```

**Response (Error - Build failed):**
```json
{
  "success": false,
  "message": "Deployment failed",
  "error": "npm run build failed: ..."
}
```

**Response (Error - dist/index.html not found):**
```json
{
  "success": false,
  "message": "Deployment failed",
  "error": "Build succeeded but dist/index.html not found. Ensure your Vite project outputs to the dist directory."
}
```

### GET /api/deploy/{repo_id}/domain

Fetch the Cloudflare Pages domain for a deployed repository.

**Request:**
```bash
curl http://localhost:5000/api/deploy/12345/domain
```

**Response (Success):**
```json
{
  "success": true,
  "repo_id": "12345",
  "project_name": "my-repo",
  "domain": "https://my-repo.pages.dev",
  "username": "user1",
  "git_url": "https://github.com/owner/my-repo",
  "owner": "owner",
  "repo_name": "my-repo"
}
```

### POST /api/deploy (Legacy)

Legacy endpoint for backward compatibility. Trigger a deployment using MongoDB ObjectId.

**Request:**
```bash
curl -X POST http://localhost:5000/api/deploy \
  -H "Content-Type: application/json" \
  -d '{"repo_id": "6954ed250d9fa1238cb13e3c"}'
```

### GET /api/health

Health check endpoint.

**Request:**
```bash
curl http://localhost:5000/api/health
```

**Response:**
```json
{
  "status": "healthy",
  "service": "M1 Instance - Sycord Deployment Server",
  "instance": "M1"
}
```

### GET /api/logs

Retrieve recent server logs stored in memory.

**Query Parameters:**
- `project_id` (optional): Filter logs by project ID tag. Defaults to the server `PROJECT_ID`.
- `limit` (optional): Number of latest lines to return (default 200, max 500).

**Request:**
```bash
curl "http://localhost:5000/api/logs?project_id=6957a3fb538e5f68b68b58f7&limit=50"
```

**Response:**
```json
{
  "success": true,
  "project_id": "6957a3fb538e5f68b68b58f7",
  "logs": [
    "2026-01-02 10:56:42,117 [INFO] [6957a3fb538e5f68b68b58f7] Deployment successful! Project: test"
  ]
}
```

## Web Interface

Visit `http://localhost:5000` in your browser to access the modern dark-themed UI with:
- M1 Instance branding
- Real-time data sync visualization (GitHub → Cloudflare)
- Repository selection (by username/repo_id)
- One-click deployment

### Mobile View

![Mobile UI](https://github.com/user-attachments/assets/7377a3d3-5477-4948-a1ef-9616933a6faa)

## Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `MONGO_URI` | MongoDB connection string | No | `mongodb://localhost:27017/` |
| `MONGO_DB` | MongoDB database name | No | `main` |
| `MONGO_COLLECTION` | MongoDB collection name | No | `users` |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token | Yes | - |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID | Yes | - |
| `PORT` | Server port | No | `5000` |
| `DEBUG` | Enable Flask debug mode | No | `False` |

## Deployment Flow

1. User selects a repository from the UI (username/repo_id)
2. Server retrieves repository config (`git_url`, `git_token`) from MongoDB
3. Downloads repository from GitHub as a zip archive using `git_token`
4. Extracts files to a temporary directory
5. **Build Step (for Vite/Node.js projects):**
   - Checks if `package.json` exists in the repository
   - If found, runs `npm install` to install dependencies
   - Runs `npm run build` to build the project
   - Verifies `dist/index.html` exists after the build
   - Uses the `dist` folder for deployment (standard Vite output)
6. Creates a new Cloudflare Pages project (if needed)
7. Executes `wrangler pages deploy` command
8. Uploads files to Cloudflare Pages
9. Cleans up temporary directory
10. Returns deployment result with live URL

### Vite Framework Support

This server automatically detects and builds Vite framework projects:

| Configuration | Value |
|---------------|-------|
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Entry Point | `dist/index.html` |

For static HTML projects (without `package.json`), the entire repository is deployed directly.

## Troubleshooting

### Wrangler not found
Ensure Wrangler is installed globally:
```bash
npm install -g wrangler
```

### MongoDB connection failed
Verify your `MONGO_URI` is correct and MongoDB is running:
```bash
mongosh "your-mongo-uri"
```

### Repository not found
Ensure the user document has a `git_connection` array with repository entries containing `repo_id`, `git_url`, and `git_token`.

### GitHub token issues
- Ensure the `git_token` has `repo` scope permissions
- Verify the token is not expired
- Check if the token has access to the repository (for private repos)

### Cloudflare deployment failed
- Verify your `CLOUDFLARE_API_TOKEN` has the correct permissions
- Check that `CLOUDFLARE_ACCOUNT_ID` is correct
- Review Wrangler logs in the API response

### Build failed (Vite projects)
- Ensure your `package.json` has a valid `build` script
- Check that all dependencies are correctly specified in `package.json`
- Verify that `npm run build` works locally
- For Vite projects, ensure the build outputs to the `dist` directory

### dist/index.html not found
- Verify your Vite configuration outputs to the `dist` directory
- Check if the `build.outDir` in `vite.config.js` is set to `dist` (default)
- Ensure the project has an `index.html` entry point

## License

MIT

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.
