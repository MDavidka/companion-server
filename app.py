import os
import re
import subprocess
import tempfile
import shutil
import requests
import json
from collections import deque
from threading import Lock
from datetime import datetime
from flask import Flask, render_template, request, jsonify, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix
from pymongo import MongoClient
from bson import ObjectId
from bson.errors import InvalidId
from dotenv import load_dotenv
import logging
from pathlib import Path
from contextvars import ContextVar

# Load environment variables
load_dotenv()

# Context variable for project tag
current_project_tag = ContextVar('project_tag', default=None)


def build_project_tag(project_id):
    """Create a consistent project log tag."""
    return str(project_id) if project_id else None


# Configure logging
PROJECT_ID = os.getenv('PROJECT_ID', '')
DEFAULT_PROJECT_TAG = 'project-log'
PROJECT_LOG_TAG = build_project_tag(PROJECT_ID) or DEFAULT_PROJECT_TAG
DEBUG_LOG_LIMIT = 50
LOG_FORMAT = '%(asctime)s [%(levelname)s] [%(project_tag)s] %(message)s'


class ProjectLogFilter(logging.Filter):
    """Inject project tag into all log records."""

    def filter(self, record):
        tag = current_project_tag.get()
        if tag:
            record.project_tag = tag
        else:
            record.project_tag = PROJECT_LOG_TAG
        return True


class InMemoryLogHandler(logging.Handler):
    """Store recent log lines in memory for retrieval."""

    def __init__(self, max_entries=500):
        super().__init__()
        self.buffer = deque(maxlen=max_entries)
        self.buffer_lock = Lock()

    def emit(self, record):
        try:
            tag = getattr(record, 'project_tag', None)
            msg = self.format(record)
            with self.buffer_lock:
                self.buffer.append({'tag': tag, 'message': msg})
        except Exception:
            self.handleError(record)


logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
root_logger = logging.getLogger()
project_filter = ProjectLogFilter()
root_logger.addFilter(project_filter)
for handler in root_logger.handlers:
    handler.addFilter(project_filter)

memory_handler = InMemoryLogHandler()
memory_handler.setLevel(logging.INFO)
memory_handler.setFormatter(logging.Formatter(LOG_FORMAT))
root_logger.addHandler(memory_handler)

logger = logging.getLogger(__name__)


def clamp_log_limit(limit):
    """Ensure requested log limit stays within buffer bounds."""
    max_limit = memory_handler.buffer.maxlen
    if not limit or limit < 1:
        return max_limit
    return min(limit, max_limit)


def get_recent_logs(project_id=None, limit=200):
    """Return recent log lines, optionally filtered by project id tag."""
    target_tag = build_project_tag(project_id)
    safe_limit = clamp_log_limit(limit)
    with memory_handler.buffer_lock:
        entries = list(memory_handler.buffer)
    if target_tag:
        logs = [entry.get('message') for entry in entries if entry.get('tag') == target_tag]
    else:
        logs = [entry.get('message') for entry in entries]
    return logs[-safe_limit:]


def deployment_error_response(message, error=None, status_code=500, project_id=None, extra=None):
    """Build a standardized deployment error response with debug logs."""
    payload = {
        'success': False,
        'message': message,
        'debug_logs': get_recent_logs(project_id, DEBUG_LOG_LIMIT)
    }
    if error is not None:
        payload['error'] = error
    if extra:
        payload.update(extra)
    return jsonify(payload), status_code


app = Flask(__name__)
# Tell Flask it is behind a proxy, to trust X-Forwarded-* headers.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

# MongoDB configuration
MONGO_URI = os.getenv('MONGO_URI', 'mongodb://localhost:27017/')
MONGO_DB = os.getenv('MONGO_DB', 'main')
MONGO_COLLECTION = os.getenv('MONGO_COLLECTION', 'users')

# Cloudflare DNS configuration (used only for creating subdomain CNAME records)
CLOUDFLARE_API_TOKEN = os.getenv('CLOUDFLARE_API_TOKEN')
CLOUDFLARE_ZONE_ID = os.getenv('CLOUDFLARE_ZONE_ID')
CLOUDFLARE_DOMAIN = os.getenv('CLOUDFLARE_DOMAIN', 'micro1.sycord.com')

# API timeout configuration (in seconds)
API_TIMEOUT = 30
DOWNLOAD_TIMEOUT = 120
BUILD_TIMEOUT = 300  # 5 minutes timeout for npm install/build

# Local deployment configuration
DEPLOYMENTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'deployments')
SERVER_HOST = os.getenv('SERVER_HOST', 'micro1.sycord.com')
os.makedirs(DEPLOYMENTS_DIR, exist_ok=True)


def sanitize_project_name(name):
    """Sanitize a repository name for use as a deployment project name."""
    if not name:
        return 'unnamed-project'
    # Replace any non-alphanumeric characters (except hyphens) with hyphens
    sanitized = re.sub(r'[^a-zA-Z0-9-]', '-', name.lower())
    # Subdomain labels have a max length of 63 characters
    return sanitized[:63]


def sanitize_filename(filename):
    """Sanitize filename to prevent path traversal attacks"""
    if not filename:
        return 'index.html'
    
    # Normalize path separators to forward slashes for consistent checking
    normalized = filename.replace('\\', '/')
    
    # Reject absolute paths
    if os.path.isabs(filename) or filename.startswith('/'):
        logger.warning(f"Rejected absolute path: {filename}")
        return os.path.basename(normalized)
    
    # Reject paths that try to go up directories
    if (normalized.startswith('..') or 
        '/..' in normalized or 
        normalized.endswith('/..')):
        logger.warning(f"Rejected path traversal attempt: {filename}")
        return os.path.basename(normalized)
    
    # Use normpath after validation to clean up the path
    safe_filename = os.path.normpath(normalized)
    
    # Final check: ensure no '..' components remain after normalization
    # Split by os.sep since normpath converts to os-specific separators
    path_parts = safe_filename.split(os.sep)
    if '..' in path_parts:
        logger.warning(f"Rejected path with '..' after normalization: {filename}")
        return os.path.basename(normalized)
    
    return safe_filename


def get_mongo_client():
    """Create and return MongoDB client"""
    try:
        client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
        # Test connection
        client.server_info()
        return client
    except Exception as e:
        logger.error(f"Failed to connect to MongoDB: {e}")
        raise


def get_github_token_from_mongo():
    """Retrieve GitHub token from MongoDB based on project ID"""
    try:
        client = get_mongo_client()
        db = client[MONGO_DB]
        collection = db[MONGO_COLLECTION]
        
        # Find the document with the project ID
        doc = collection.find_one({'_id': ObjectId(PROJECT_ID)})
        
        if doc and 'token' in doc:
            logger.info("Retrieved GitHub token from MongoDB")
            return doc['token']
        
        # Also try looking for github_token field
        if doc and 'github_token' in doc:
            logger.info("Retrieved GitHub token from MongoDB")
            return doc['github_token']
            
        logger.warning("GitHub token not found in MongoDB document")
        return None
    except Exception as e:
        logger.error(f"Error retrieving GitHub token from MongoDB: {e}")
        return None
    finally:
        if 'client' in locals():
            client.close()


def get_repository_projection(include_tokens=False):
    """Build MongoDB projection for repository documents"""
    projection = {
        'owner': 1,
        'repo': 1,
        'name': 1,
        'description': 1,
        'default_branch': 1,
        'private': 1
    }
    if include_tokens:
        projection.update({'token': 1, 'github_token': 1})
    return projection


def get_all_users_with_repos():
    """
    Retrieve all users and their git repositories from the new database structure.
    Structure: main > users > {username} > git_connection > {repo_id: {repo doc}}
    git_connection is a dictionary where keys are repo_ids and values are repo documents.
    Each repo doc contains: username, repo_id, git_url, git_token, repo_name, project_id, deployed_at
    """
    try:
        client = get_mongo_client()
        db = client[MONGO_DB]
        collection = db[MONGO_COLLECTION]
        
        # Find all user documents that have git_connection field
        users = list(collection.find({'git_connection': {'$exists': True}}, {'username': 1, 'git_connection': 1}))
        logger.info(f"Retrieved {len(users)} users with git connections from MongoDB")
        return users
    except Exception as e:
        logger.error(f"Error retrieving users with repos from MongoDB: {e}")
        raise
    finally:
        if 'client' in locals():
            client.close()


def get_user_repos(username):
    """
    Retrieve all repositories for a specific user.
    Returns list of repo documents from git_connection field.
    git_connection is a dictionary where keys are repo_ids and values are repo documents.
    """
    try:
        client = get_mongo_client()
        db = client[MONGO_DB]
        collection = db[MONGO_COLLECTION]
        
        user_doc = collection.find_one({'username': username}, {'git_connection': 1})
        
        if user_doc and 'git_connection' in user_doc:
            git_connection = user_doc['git_connection']
            # git_connection is a dictionary {repo_id: repo_doc}
            # Convert to list of repo documents
            if isinstance(git_connection, dict):
                repos = list(git_connection.values())
            else:
                # Fallback for legacy array format
                repos = git_connection
            logger.info(f"Retrieved {len(repos)} repositories for user {username}")
            return repos
        
        logger.warning(f"No repositories found for user {username}")
        return []
    except Exception as e:
        logger.error(f"Error retrieving repositories for user {username}: {e}")
        raise
    finally:
        if 'client' in locals():
            client.close()


def get_repo_by_user_and_id(username, repo_id):
    """
    Retrieve a specific repository by username and repo_id.
    Returns the repo document with git_url and git_token.
    git_connection is a dictionary where keys are repo_ids.
    """
    try:
        client = get_mongo_client()
        db = client[MONGO_DB]
        collection = db[MONGO_COLLECTION]
        
        # Find user document
        user_doc = collection.find_one({'username': username}, {'git_connection': 1})
        
        if not user_doc or 'git_connection' not in user_doc:
            logger.warning(f"User {username} not found or has no git connections")
            return None
        
        git_connection = user_doc['git_connection']
        repo_id_str = str(repo_id)
        
        # git_connection is a dictionary {repo_id: repo_doc}
        if isinstance(git_connection, dict):
            # Direct lookup by key
            if repo_id_str in git_connection:
                logger.info(f"Found repository {repo_id} for user {username}")
                return git_connection[repo_id_str]
        else:
            # Fallback for legacy array format
            for repo in git_connection:
                if str(repo.get('repo_id', '')) == repo_id_str:
                    logger.info(f"Found repository {repo_id} for user {username}")
                    return repo
        
        logger.warning(f"Repository {repo_id} not found for user {username}")
        return None
    except Exception as e:
        logger.error(f"Error retrieving repository {repo_id} for user {username}: {e}")
        raise
    finally:
        if 'client' in locals():
            client.close()


def get_repo_by_id(repo_id):
    """
    Retrieve a specific repository by repo_id across all users.
    Returns the repo document with git_url, git_token, and the associated username.
    """
    try:
        users = get_all_users_with_repos()
        repo_id_str = str(repo_id)

        for user in users:
            username = user.get('username')
            git_connection = user.get('git_connection', {})

            if isinstance(git_connection, dict):
                if repo_id_str in git_connection:
                    repo = dict(git_connection[repo_id_str] or {})
                    repo.setdefault('username', username)
                    repo.setdefault('repo_id', repo_id_str)
                    return repo
            else:
                for repo in git_connection:
                    if str(repo.get('repo_id', '')) == repo_id_str:
                        repo_with_user = dict(repo)
                        repo_with_user.setdefault('username', username)
                        repo_with_user.setdefault('repo_id', repo_id_str)
                        return repo_with_user

        logger.warning(f"Repository {repo_id} not found across users")
        return None
    except Exception as e:
        logger.error(f"Error retrieving repository {repo_id}: {e}")
        raise


def get_repository_documents(include_tokens=False):
    """
    Retrieve all repository documents from all users.
    This aggregates repos from the new structure: main > users > git_connection
    git_connection is a dictionary where keys are repo_ids and values are repo documents.
    """
    try:
        users = get_all_users_with_repos()
        all_repos = []
        
        for user in users:
            username = user.get('username', 'unknown')
            git_connection = user.get('git_connection', {})
            
            # git_connection is a dictionary {repo_id: repo_doc}
            if isinstance(git_connection, dict):
                repos = git_connection.values()
            else:
                # Fallback for legacy array format
                repos = git_connection
            
            for repo in repos:
                repo_doc = {
                    'username': username,
                    'repo_id': repo.get('repo_id'),
                    'git_url': repo.get('git_url'),
                    'repo_name': repo.get('repo_name'),
                }
                if include_tokens:
                    repo_doc['git_token'] = repo.get('git_token')
                all_repos.append(repo_doc)
        
        logger.info(f"Retrieved {len(all_repos)} total repository documents")
        return all_repos
    except Exception as e:
        logger.error(f"Error retrieving repository documents: {e}")
        raise


def get_repository_document_by_id(repo_id, include_tokens=False):
    """Retrieve a single repository document by its ID (legacy support)"""
    try:
        client = get_mongo_client()
        db = client[MONGO_DB]
        collection = db[MONGO_COLLECTION]
        projection = get_repository_projection(include_tokens)
        
        try:
            object_id = ObjectId(repo_id)
        except (InvalidId, TypeError):
            logger.warning(f"Invalid repository id: {repo_id}")
            return None
        
        doc = collection.find_one({'_id': object_id}, projection)
        return doc
    except Exception as e:
        logger.error(f"Error retrieving repository document from MongoDB: {e}")
        raise
    finally:
        if 'client' in locals():
            client.close()


def get_repository_name(repo_doc):
    """Extract repository name (prefer new 'repo' field, fall back to legacy 'name' field). Returns None if neither is set."""
    return repo_doc.get('repo') or repo_doc.get('name')


def get_repository_token(repo_doc):
    """Return repository token, preferring 'token' and falling back to legacy 'github_token'. Returns None if neither exists."""
    return repo_doc.get('token') or repo_doc.get('github_token')


def parse_git_url(git_url):
    """
    Parse a git URL to extract owner and repo name.
    Supports formats like:
    - https://github.com/owner/repo
    - https://github.com/owner/repo.git
    - git@github.com:owner/repo.git
    Returns (owner, repo_name) tuple or (None, None) if parsing fails.
    """
    if not git_url:
        return None, None
    
    # HTTPS format - strip .git suffix if present
    https_match = re.match(r'https?://github\.com/([^/]+)/([^/]+?)(?:\.git)?$', git_url)
    if https_match:
        return https_match.group(1), https_match.group(2)
    
    # SSH format - strip .git suffix if present
    ssh_match = re.match(r'git@github\.com:([^/]+)/([^/]+?)(?:\.git)?$', git_url)
    if ssh_match:
        return ssh_match.group(1), ssh_match.group(2)
    
    logger.warning(f"Could not parse git URL: {git_url}")
    return None, None


def get_github_repositories(github_token):
    """Fetch repositories from GitHub using the token"""
    if not github_token:
        logger.error("No GitHub token provided")
        return []
    
    try:
        headers = {
            'Authorization': f'token {github_token}',
            'Accept': 'application/vnd.github.v3+json'
        }
        
        response = requests.get(
            'https://api.github.com/user/repos',
            headers=headers,
            params={'per_page': 100, 'sort': 'updated'},
            timeout=API_TIMEOUT
        )
        
        if response.status_code == 200:
            repos = response.json()
            logger.info(f"Fetched {len(repos)} repositories from GitHub")
            return repos
        else:
            logger.error(f"GitHub API error: {response.status_code} - {response.text}")
            return []
    except requests.exceptions.RequestException as e:
        logger.error(f"Error fetching GitHub repositories: {e}")
        return []


def download_github_repo(github_token, repo_full_name, branch='main'):
    """Download a GitHub repository to a temporary directory"""
    temp_dir = tempfile.mkdtemp(prefix='github_repo_')
    logger.info(f"Created temporary directory for repo: {temp_dir}")
    
    try:
        # Try to download the repository as a zip archive
        headers = {
            'Authorization': f'token {github_token}',
            'Accept': 'application/vnd.github.v3+json'
        }
        
        # First, try main branch, then master if main fails
        branches_to_try = [branch, 'main', 'master']
        
        for try_branch in branches_to_try:
            url = f'https://api.github.com/repos/{repo_full_name}/zipball/{try_branch}'
            response = requests.get(url, headers=headers, stream=True, timeout=DOWNLOAD_TIMEOUT)
            
            if response.status_code == 200:
                # Save the zip file
                zip_path = os.path.join(temp_dir, 'repo.zip')
                with open(zip_path, 'wb') as f:
                    for chunk in response.iter_content(chunk_size=8192):
                        f.write(chunk)
                
                # Extract the zip file
                import zipfile
                with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                    zip_ref.extractall(temp_dir)
                
                # Remove the zip file
                os.remove(zip_path)
                
                # Find the extracted directory (GitHub adds a prefix)
                extracted_dirs = [d for d in os.listdir(temp_dir) 
                                if os.path.isdir(os.path.join(temp_dir, d))]
                
                if extracted_dirs:
                    # Move contents from extracted dir to temp_dir
                    extracted_path = os.path.join(temp_dir, extracted_dirs[0])
                    for item in os.listdir(extracted_path):
                        src = os.path.join(extracted_path, item)
                        dst = os.path.join(temp_dir, item)
                        shutil.move(src, dst)
                    os.rmdir(extracted_path)
                
                logger.info(f"Downloaded repository {repo_full_name} from branch {try_branch}")
                return temp_dir
        
        # If all branches fail
        logger.error(f"Failed to download repository {repo_full_name}")
        shutil.rmtree(temp_dir, ignore_errors=True)
        return None
        
    except Exception as e:
        logger.error(f"Error downloading repository: {e}")
        shutil.rmtree(temp_dir, ignore_errors=True)
        return None


def create_cloudflare_dns_record(project_name, pages_domain):
    """Create or update a Cloudflare DNS CNAME record pointing to a Cloudflare Pages domain.

    Creates a proxied CNAME record: <project_name>.<CLOUDFLARE_DOMAIN> -> <pages_domain>
    Returns a dict with 'subdomain' and 'url' on success, or None on failure.
    """
    if not CLOUDFLARE_API_TOKEN or not CLOUDFLARE_ZONE_ID:
        logger.error("Cloudflare API token or zone ID not configured for DNS record creation")
        return None

    subdomain = f"{project_name}.{CLOUDFLARE_DOMAIN}"
    records_url = f'https://api.cloudflare.com/client/v4/zones/{CLOUDFLARE_ZONE_ID}/dns_records'
    headers = {
        'Authorization': f'Bearer {CLOUDFLARE_API_TOKEN}',
        'Content-Type': 'application/json'
    }

    try:
        # Check whether a CNAME already exists for this subdomain
        list_response = requests.get(
            records_url,
            headers=headers,
            params={'type': 'CNAME', 'name': subdomain},
            timeout=API_TIMEOUT
        )
        list_data = list_response.json()
        existing_records = list_data.get('result', [])

        payload = {
            'type': 'CNAME',
            'name': subdomain,
            'content': pages_domain,
            'ttl': 1,       # 1 = automatic TTL (recommended for proxied records)
            'proxied': True
        }

        if existing_records:
            # Update the existing record
            record_id = existing_records[0]['id']
            response = requests.put(
                f'{records_url}/{record_id}',
                headers=headers,
                json=payload,
                timeout=API_TIMEOUT
            )
            action = 'Updated'
        else:
            # Create a new record
            response = requests.post(
                records_url,
                headers=headers,
                json=payload,
                timeout=API_TIMEOUT
            )
            action = 'Created'

        if response.status_code in [200, 201]:
            result = response.json()
            if result.get('success'):
                logger.info(f"{action} DNS record: {subdomain} -> {pages_domain}")
                return {
                    'success': True,
                    'subdomain': subdomain,
                    'url': f"https://{subdomain}"
                }
            else:
                logger.error(f"Cloudflare DNS API error: {result.get('errors')}")
                return None
        else:
            logger.error(f"Cloudflare DNS API error: {response.status_code} - {response.text}")
            return None
    except requests.exceptions.RequestException as e:
        logger.error(f"Error creating Cloudflare DNS record: {e}")
        return None


def fix_commonjs_config_files(directory_path):
    """
    Check for CommonJS config files in an ESM project and rename them to .cjs.
    This fixes issues where 'type': 'module' in package.json conflicts with
    module.exports in postcss.config.js or tailwind.config.js.
    """
    package_json_path = os.path.join(directory_path, 'package.json')
    if not os.path.exists(package_json_path):
        return

    try:
        with open(package_json_path, 'r') as f:
            package_data = json.load(f)

        # Only proceed if the project is ESM
        if package_data.get('type') != 'module':
            return

        # List of config files to check
        config_files = ['postcss.config.js', 'tailwind.config.js']

        for config_file in config_files:
            file_path = os.path.join(directory_path, config_file)
            if os.path.exists(file_path):
                # Check if the file uses CommonJS syntax (module.exports)
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        content = f.read()

                    if 'module.exports' in content:
                        new_path = os.path.join(directory_path, config_file.replace('.js', '.cjs'))
                        os.rename(file_path, new_path)
                        logger.info(f"Renamed {config_file} to .cjs to fix ESM/CommonJS conflict")
                except Exception as e:
                    logger.warning(f"Failed to check/rename {config_file}: {e}")

    except Exception as e:
        logger.warning(f"Error checking package.json for ESM configuration: {e}")


def build_vite_project(directory_path):
    """
    Build a Vite project by running npm install and npm run build.
    Returns a dict with success status, deploy_path, and error message.
    
    For Vite/TypeScript framework projects:
    - Build command: npm run build
    - Output directory: dist (This folder contains the production-ready assets)
    - Note: This intentionally reduces the deployed files to only the build artifacts.
    """
    package_json_path = os.path.join(directory_path, 'package.json')
    
    # Check if package.json exists
    if not os.path.exists(package_json_path):
        logger.info("No package.json found, skipping build step")
        return {
            'success': True,
            'deploy_path': directory_path,
            'built': False,
            'error': None
        }
    
    logger.info(f"Found package.json, building Vite project in {directory_path}")
    
    # Fix potential ESM/CommonJS conflicts before installing/building
    fix_commonjs_config_files(directory_path)

    try:
        # Prepare environment variables
        # Force NODE_ENV=development for install to ensure devDependencies (like vite) are installed
        install_env = os.environ.copy()
        install_env['NODE_ENV'] = 'development'

        # Run npm install
        logger.info("Running npm install...")
        install_result = subprocess.run(
            ['npm', 'install'],
            cwd=directory_path,
            env=install_env,
            capture_output=True,
            text=True,
            timeout=BUILD_TIMEOUT
        )
        
        if install_result.returncode != 0:
            logger.error("npm install failed")
            logger.error("STDOUT:\n%s", install_result.stdout)
            logger.error("STDERR:\n%s", install_result.stderr)
            return {
                'success': False,
                'deploy_path': None,
                'built': False,
                'error': f'npm install failed: {install_result.stderr}'
            }
        
        logger.info("npm install completed successfully")
        
        # Run npm run build
        # Force NODE_ENV=production for build to ensure optimized output
        build_env = os.environ.copy()
        build_env['NODE_ENV'] = 'production'

        logger.info("Running npm run build...")
        build_result = subprocess.run(
            ['npm', 'run', 'build'],
            cwd=directory_path,
            env=build_env,
            capture_output=True,
            text=True,
            timeout=BUILD_TIMEOUT
        )
        
        if build_result.returncode != 0:
            logger.error("npm run build failed")
            logger.error("STDOUT:\n%s", build_result.stdout)
            logger.error("STDERR:\n%s", build_result.stderr)
            return {
                'success': False,
                'deploy_path': None,
                'built': False,
                'error': f'npm run build failed: {build_result.stderr}'
            }
        
        logger.info("npm run build completed successfully")
        
        # Check if dist/index.html exists
        dist_path = os.path.join(directory_path, 'dist')
        dist_index_path = os.path.join(dist_path, 'index.html')
        
        if not os.path.exists(dist_index_path):
            logger.error(f"Build succeeded but dist/index.html not found at {dist_index_path}")
            return {
                'success': False,
                'deploy_path': None,
                'built': True,
                'error': 'Build succeeded but dist/index.html not found. '
                         'Ensure your Vite project outputs to the dist directory.'
            }
        
        # Create _redirects file for SPA support if it doesn't exist
        # This prevents "white page" issues on non-root routes by directing everything to index.html
        redirects_path = os.path.join(dist_path, '_redirects')
        if not os.path.exists(redirects_path):
            try:
                with open(redirects_path, 'w') as f:
                    f.write("/* /index.html 200\n")
                logger.info("Created _redirects file for SPA routing support")
            except Exception as e:
                logger.warning(f"Failed to create _redirects file: {e}")

        # Log the files to be uploaded to reassure the user
        file_count = 0
        logger.info(f"Build successful, dist/index.html found at {dist_index_path}")
        logger.info("Files to be uploaded:")
        for root, dirs, files in os.walk(dist_path):
            for file in files:
                rel_path = os.path.relpath(os.path.join(root, file), dist_path)
                logger.info(f" - {rel_path}")
                file_count += 1
        logger.info(f"Total files prepared for upload: {file_count}")
        logger.info("Note: Cloudflare Pages deduplicates uploads. 'Uploaded' count may be lower if files haven't changed.")
        
        return {
            'success': True,
            'deploy_path': dist_path,
            'built': True,
            'error': None
        }
        
    except subprocess.TimeoutExpired as e:
        logger.error(f"Build process timed out: {e}")
        return {
            'success': False,
            'deploy_path': None,
            'built': False,
            'error': 'Build process timed out after 5 minutes'
        }
    except FileNotFoundError:
        logger.error("npm command not found")
        return {
            'success': False,
            'deploy_path': None,
            'built': False,
            'error': 'npm command not found. Please ensure Node.js is installed.'
        }
    except Exception as e:
        logger.error(f"Build error: {e}")
        return {
            'success': False,
            'deploy_path': None,
            'built': False,
            'error': str(e)
        }


def deploy_to_sycord(directory_path, project_name):
    """Deploy files to the local Sycord server.

    For Vite/Node.js projects this function will:
    1. Build the project (npm install + npm run build)
    2. Copy the build output to the local deployments directory
    3. Return the deployment URL
    """
    try:
        # Build the project if it's a Vite/Node.js project
        build_result = build_vite_project(directory_path)

        if not build_result['success']:
            return {
                'success': False,
                'output': None,
                'url': None,
                'error': build_result['error']
            }

        # Use the dist folder if built, otherwise use the original directory
        deploy_path = build_result['deploy_path']
        logger.info(f"Deploying from: {deploy_path}")

        # Target directory for this deployment
        target_dir = os.path.join(DEPLOYMENTS_DIR, project_name)

        # Verify the resolved path is within DEPLOYMENTS_DIR (not equal to it)
        real_target = os.path.realpath(target_dir)
        real_deployments = os.path.realpath(DEPLOYMENTS_DIR)
        if not real_target.startswith(real_deployments + os.sep):
            logger.error(f"Rejected deployment target outside deployments directory: {project_name}")
            return {
                'success': False,
                'output': None,
                'url': None,
                'error': 'Invalid project name'
            }

        # Remove old deployment if it exists
        if os.path.exists(target_dir):
            shutil.rmtree(target_dir)
            logger.info(f"Removed previous deployment: {target_dir}")

        # Copy build output to deployments directory
        shutil.copytree(deploy_path, target_dir)

        # Count deployed files
        file_count = sum(len(files) for _, _, files in os.walk(target_dir))
        logger.info(f"Deployed {file_count} files to {target_dir}")

        # Build the URLs
        url = f"https://{project_name}.{CLOUDFLARE_DOMAIN}"
        local_url = f"/sites/{project_name}/"

        return {
            'success': True,
            'output': f'Deployed {file_count} files to sycord server ({project_name})',
            'url': url,
            'local_url': local_url,
            'error': None
        }

    except Exception as e:
        logger.error(f"Sycord deployment error: {e}")
        return {
            'success': False,
            'output': None,
            'url': None,
            'error': str(e)
        }


@app.route('/')
def index():
    """Render the main deployment dashboard"""
    return render_template('index.html')


@app.before_request
def route_subdomain():
    """Route requests from a custom subdomain to the deployed site."""
    host = request.headers.get('Host', '')
    # Strip any port number that might be present (e.g. during local testing or from proxy)
    if ':' in host:
        host = host.split(':', 1)[0]

    # Check if this is a request to a deployed site subdomain
    # The format should be <project_name>.<CLOUDFLARE_DOMAIN>
    if host and CLOUDFLARE_DOMAIN in host:
        # Avoid routing if it's the exact main domain or the server host itself
        if host != CLOUDFLARE_DOMAIN and host != SERVER_HOST and not host.startswith('www.'):
            # Extract project name from subdomain
            # E.g., project-name.micro1.sycord.com -> project-name
            project_name = host.split(f".{CLOUDFLARE_DOMAIN}")[0]

            # If the project name exists in deployments, serve it
            site_dir = os.path.join(DEPLOYMENTS_DIR, sanitize_project_name(project_name))
            if os.path.exists(site_dir):
                # We need to serve the site. Since we are in before_request,
                # we can return the response directly, bypassing the normal routing.
                path = request.path.lstrip('/')
                response = serve_site(project_name, path if path else 'index.html')
                return response


@app.route('/sites/<project_name>/')
@app.route('/sites/<project_name>/<path:filename>')
def serve_site(project_name, filename='index.html'):
    """Serve static files from deployed sites with SPA fallback."""
    safe_name = sanitize_project_name(project_name)
    site_dir = os.path.join(DEPLOYMENTS_DIR, safe_name)

    # Verify the site directory exists and is within DEPLOYMENTS_DIR
    real_site = os.path.realpath(site_dir)
    real_deployments = os.path.realpath(DEPLOYMENTS_DIR)
    if not real_site.startswith(real_deployments + os.sep):
        return jsonify({'error': 'Access denied'}), 403

    if not os.path.isdir(site_dir):
        return jsonify({'error': 'Site not found'}), 404

    file_path = os.path.join(site_dir, filename)
    real_file = os.path.realpath(file_path)
    if not real_file.startswith(real_site + os.sep) and real_file != real_site:
        return jsonify({'error': 'Access denied'}), 403

    if os.path.isfile(file_path):
        return send_from_directory(site_dir, filename)

    # SPA fallback: serve index.html for unmatched paths
    return send_from_directory(site_dir, 'index.html')


@app.route('/api/sites', methods=['GET'])
def list_sites():
    """API endpoint to list all deployed sites on this server."""
    sites = []
    if os.path.exists(DEPLOYMENTS_DIR):
        for name in sorted(os.listdir(DEPLOYMENTS_DIR)):
            site_path = os.path.join(DEPLOYMENTS_DIR, name)
            if os.path.isdir(site_path):
                file_count = sum(len(files) for _, _, files in os.walk(site_path))
                mtime = os.path.getmtime(site_path)
                sites.append({
                    'name': name,
                    'url': f"https://{name}.{CLOUDFLARE_DOMAIN}",
                    'local_url': f"/sites/{name}/",
                    'files': file_count,
                    'deployed_at': datetime.fromtimestamp(mtime).isoformat()
                })
    return jsonify({
        'success': True,
        'sites': sites,
        'total': len(sites)
    }), 200


@app.route('/api/logs', methods=['GET', 'OPTIONS'])
def get_logs():
    """API endpoint to retrieve recent logs, filtered by project id tag."""
    if request.method == 'OPTIONS':
        response = app.make_default_options_response()
    else:
        project_id = request.args.get('project_id') or PROJECT_ID
        limit = request.args.get('limit', default=200, type=int)
        logs = get_recent_logs(project_id, clamp_log_limit(limit))
        response = jsonify({
            'success': True,
            'project_id': project_id,
            'logs': logs
        })

    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response, response.status_code


@app.route('/api/repos', methods=['GET'])
def get_repos():
    """
    API endpoint to fetch GitHub repositories from new database structure.
    
    Structure: main > users > {username} > git_connection > {repo_id: {repo doc}}
    git_connection is a dictionary where keys are repo_ids.
    Each repo doc contains: username, repo_id, git_url, git_token, repo_name, project_id, deployed_at
    
    Response format:
    {
        "success": true,
        "repositories": [
            {
                "username": "user1",
                "repo_id": "1126661988",
                "git_url": "https://github.com/owner/repo",
                "name": "repo"
            }
        ]
    }
    """
    try:
        logger.info("Fetching GitHub repositories from new structure")
        
        # Get repository documents from MongoDB (new structure)
        repo_docs = get_repository_documents()
        
        if not repo_docs:
            return jsonify({
                'success': True,
                'message': 'No repositories found in database',
                'repositories': []
            }), 200
        
        # Format repositories for frontend
        formatted_repos = []
        for repo_doc in repo_docs:
            username = repo_doc.get('username')
            repo_id = repo_doc.get('repo_id')
            git_url = repo_doc.get('git_url')
            repo_name_from_db = repo_doc.get('repo_name')
            
            if not username or not repo_id:
                logger.warning(f"Skipping repository document missing username or repo_id")
                continue
            
            # Extract repo name from git_url or use repo_name from database
            owner, repo_name_from_url = parse_git_url(git_url)
            repo_name = repo_name_from_db or repo_name_from_url or f'repo-{repo_id}'
            
            formatted_repos.append({
                'username': username,
                'repo_id': str(repo_id),
                'git_url': git_url,
                'name': repo_name,
                'owner': owner,
                'full_name': f"{owner}/{repo_name_from_url}" if owner and repo_name_from_url else None
            })
        
        return jsonify({
            'success': True,
            'repositories': formatted_repos
        }), 200
        
    except Exception as e:
        logger.error(f"Error fetching repositories: {e}")
        return jsonify({
            'success': False,
            'message': 'Failed to fetch repositories',
            'error': str(e),
            'repositories': []
        }), 500


@app.route('/api/repos/<username>', methods=['GET'])
def get_user_repos_endpoint(username):
    """
    API endpoint to fetch repositories for a specific user.
    
    URL: GET /api/repos/<username>
    
    Response format:
    {
        "success": true,
        "username": "user1",
        "repositories": [
            {
                "repo_id": "1126661988",
                "git_url": "https://github.com/owner/repo",
                "name": "repo"
            }
        ]
    }
    """
    try:
        logger.info(f"Fetching repositories for user: {username}")
        
        repos = get_user_repos(username)
        
        formatted_repos = []
        for repo in repos:
            git_url = repo.get('git_url')
            repo_name_from_db = repo.get('repo_name')
            owner, repo_name_from_url = parse_git_url(git_url)
            repo_name = repo_name_from_db or repo_name_from_url or f'repo-{repo.get("repo_id")}'
            
            formatted_repos.append({
                'repo_id': str(repo.get('repo_id')),
                'git_url': git_url,
                'name': repo_name,
                'owner': owner,
                'full_name': f"{owner}/{repo_name_from_url}" if owner and repo_name_from_url else None
            })
        
        return jsonify({
            'success': True,
            'username': username,
            'repositories': formatted_repos
        }), 200
        
    except Exception as e:
        logger.error(f"Error fetching repositories for user {username}: {e}")
        return jsonify({
            'success': False,
            'message': f'Failed to fetch repositories for user {username}',
            'error': str(e),
            'repositories': []
        }), 500


@app.route('/api/deploy/<repo_id>', methods=['GET', 'POST'])
def deploy_by_repo(repo_id):
    """
    API endpoint to trigger deployment for a specific repository by repo_id.

    URL: GET/POST /api/deploy/<repo_id>

    Parameters:
    - repo_id: Repository identifier (numeric string)

    The endpoint retrieves repository details from the database:
    - git_url: GitHub repository URL
    - git_token: GitHub personal access token for authentication

    Process:
    1. Validate repo_id
    2. Retrieve repository configuration from database
    3. Download repository from GitHub using git_token
    4. Build and deploy to sycord server
    5. Return deployment result with URL

    Response format (success):
    {
        "success": true,
        "message": "Deployment successful! Project: repo-name",
        "project_name": "repo-name",
        "url": "https://repo-name.sycord.com",
        "username": "user1",
        "repo_id": "12345"
    }

    Response format (error):
    {
        "success": false,
        "message": "Error description",
        "error": "Detailed error message"
    }
    """
    project_id_for_debug = None
    try:
        logger.info(f"Received deployment request for repo_id={repo_id}")

        # Validate repo_id format (should be numeric string)
        if not repo_id or not re.match(r'^\d+$', repo_id):
            return jsonify({
                'success': False,
                'message': 'Invalid repo_id format. Expected numeric identifier.'
            }), 400

        # Get repository details from MongoDB (new structure)
        repo_doc = get_repo_by_id(repo_id)
        project_id_for_debug = repo_doc.get('project_id') if repo_doc else None

        if not repo_doc:
            return jsonify({
                'success': False,
                'message': f'Repository {repo_id} not found'
            }), 404

        git_token = repo_doc.get('git_token')
        git_url = repo_doc.get('git_url')
        username = repo_doc.get('username')

        if not git_token:
            return jsonify({
                'success': False,
                'message': 'GitHub token (git_token) not found for repository'
            }), 404

        if not git_url:
            return jsonify({
                'success': False,
                'message': 'Git URL (git_url) not found for repository'
            }), 404

        # Parse git_url to extract owner and repo name
        owner, repo_name = parse_git_url(git_url)

        if not owner or not repo_name:
            return jsonify({
                'success': False,
                'message': f'Could not parse git_url: {git_url}'
            }), 400

        repo_full_name = f"{owner}/{repo_name}"
        default_branch = 'main'

        # Generate project name from repo name (sanitized)
        project_name = sanitize_project_name(repo_name)

        # Set context for logging
        tag = build_project_tag(repo_id)
        token = current_project_tag.set(tag)

        try:
            # Download repository from GitHub
            temp_dir = download_github_repo(git_token, repo_full_name, default_branch)

            if not temp_dir:
                return deployment_error_response(
                    'Failed to download repository from GitHub',
                    status_code=500,
                    project_id=project_id_for_debug
                )

            try:
                # Build and deploy to sycord server
                result = deploy_to_sycord(temp_dir, project_name)

                if not result['success']:
                    return deployment_error_response(
                        'Deployment failed',
                        error=result.get('error'),
                        status_code=500,
                        project_id=project_id_for_debug
                    )

                # Create Cloudflare DNS CNAME record (required step)
                if not CLOUDFLARE_API_TOKEN or not CLOUDFLARE_ZONE_ID:
                    logger.error(
                        "Cloudflare DNS not configured: "
                        "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID must be set"
                    )
                    return deployment_error_response(
                        'Cloudflare DNS setup failed: CLOUDFLARE_API_TOKEN and '
                        'CLOUDFLARE_ZONE_ID environment variables are required to '
                        f'create the {project_name}.{CLOUDFLARE_DOMAIN} subdomain.',
                        status_code=500,
                        project_id=project_id_for_debug
                    )

                dns_result = create_cloudflare_dns_record(project_name, SERVER_HOST)
                if not dns_result:
                    logger.error(
                        f"Cloudflare DNS record creation failed for "
                        f"{project_name}.{CLOUDFLARE_DOMAIN}"
                    )
                    return deployment_error_response(
                        f'Files deployed but Cloudflare DNS record creation failed '
                        f'for {project_name}.{CLOUDFLARE_DOMAIN}. '
                        'Check CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID.',
                        status_code=500,
                        project_id=project_id_for_debug
                    )

                return jsonify({
                    'success': True,
                    'message': f'Deployment successful! Project: {project_name}',
                    'project_name': project_name,
                    'url': dns_result.get('url') if dns_result.get('url') is not None else result.get('url'),
                    'local_url': result.get('local_url'),
                    'username': username,
                    'repo_id': repo_id,
                    'output': result['output'],
                    'dns_record_created': True
                }), 200
            finally:
                # Clean up temporary directory
                shutil.rmtree(temp_dir, ignore_errors=True)
                logger.info(f"Cleaned up temporary directory: {temp_dir}")
        finally:
            current_project_tag.reset(token)

    except Exception as e:
        logger.error(f"Deployment error: {e}")
        return deployment_error_response(
            'Deployment failed',
            error=str(e),
            status_code=500,
            project_id=project_id_for_debug
        )


@app.route('/api/deploy/<repo_id>/domain', methods=['GET'])
def get_deployment_domain(repo_id):
    """
    API endpoint to retrieve the deployment domain for a repository by repo_id.
    """
    try:
        logger.info(f"Fetching deployment domain for repo_id={repo_id}")

        if not repo_id or not re.match(r'^\d+$', repo_id):
            return jsonify({
                'success': False,
                'message': 'Invalid repo_id format. Expected numeric identifier.'
            }), 400

        repo_doc = get_repo_by_id(repo_id)

        if not repo_doc:
            return jsonify({
                'success': False,
                'message': f'Repository {repo_id} not found'
            }), 404

        git_url = repo_doc.get('git_url')
        repo_name_db = repo_doc.get('repo_name')
        owner, repo_name_url = parse_git_url(git_url)
        repo_name = repo_name_db or repo_name_url

        if not repo_name:
            return jsonify({
                'success': False,
                'message': f'Repository name not found for repository {repo_id}'
            }), 404

        project_name = sanitize_project_name(repo_name)
        domain = f"https://{project_name}.{CLOUDFLARE_DOMAIN}" if CLOUDFLARE_ZONE_ID else None
        local_url = f"/sites/{project_name}/"

        return jsonify({
            'success': True,
            'repo_id': str(repo_id),
            'username': repo_doc.get('username'),
            'owner': owner,
            'repo_name': repo_name,
            'project_name': project_name,
            'domain': domain,
            'local_url': local_url,
            'dns_configured': bool(CLOUDFLARE_ZONE_ID),
            'git_url': git_url
        }), 200
    except Exception as e:
        logger.error(f"Error retrieving deployment domain for repo {repo_id}: {e}")
        return jsonify({
            'success': False,
            'message': 'Failed to retrieve deployment domain',
            'error': str(e)
        }), 500


@app.route('/api/deploy', methods=['POST'])
def deploy():
    """API endpoint to trigger deployment from GitHub repository (legacy support)"""
    project_id_for_debug = None
    try:
        logger.info("Received deployment request")

        # Get request data
        data = request.get_json() or {}
        repo_id = data.get('repo_id')

        if not repo_id:
            return jsonify({
                'success': False,
                'message': 'Repository ID is required'
            }), 400

        # Get repository details from MongoDB
        selected_repo = get_repository_document_by_id(repo_id, include_tokens=True)
        project_id_for_debug = selected_repo.get('project_id') if selected_repo else None

        if not selected_repo:
            return jsonify({
                'success': False,
                'message': 'Repository configuration not found'
            }), 404

        github_token = get_repository_token(selected_repo)

        if not github_token:
            return jsonify({
                'success': False,
                'message': 'GitHub token not found for repository'
            }), 404

        owner = selected_repo.get('owner')
        repo_name = get_repository_name(selected_repo)

        if not owner or not repo_name:
            return jsonify({
                'success': False,
                'message': 'Repository configuration missing owner or name'
            }), 400

        default_branch = selected_repo.get('default_branch', 'main')
        repo_full_name = f"{owner}/{repo_name}"

        # Generate project name from repo name (sanitized)
        project_name = sanitize_project_name(repo_name)

        # Set context for logging
        tag = build_project_tag(repo_id)
        token = current_project_tag.set(tag)

        try:
            # Download repository from GitHub
            temp_dir = download_github_repo(github_token, repo_full_name, default_branch)

            if not temp_dir:
                return deployment_error_response(
                    'Failed to download repository from GitHub',
                    status_code=500,
                    project_id=project_id_for_debug
                )

            try:
                # Build and deploy to sycord server
                result = deploy_to_sycord(temp_dir, project_name)

                if result['success']:
                    return jsonify({
                        'success': True,
                        'message': f'Deployment successful! Project: {project_name}',
                        'project_name': project_name,
                        'url': result.get('url'),
                        'local_url': result.get('local_url'),
                        'output': result['output']
                    }), 200
                else:
                    return deployment_error_response(
                        'Deployment failed',
                        error=result.get('error'),
                        status_code=500,
                        project_id=project_id_for_debug
                    )
            finally:
                # Clean up temporary directory
                shutil.rmtree(temp_dir, ignore_errors=True)
                logger.info(f"Cleaned up temporary directory: {temp_dir}")
        finally:
            current_project_tag.reset(token)

    except Exception as e:
        logger.error(f"Deployment error: {e}")
        return deployment_error_response(
            'Deployment failed',
            error=str(e),
            status_code=500,
            project_id=project_id_for_debug
        )


@app.route('/api/health', methods=['GET'])
def health():
    """Health check endpoint"""
    deployed_count = 0
    if os.path.exists(DEPLOYMENTS_DIR):
        deployed_count = sum(
            1 for n in os.listdir(DEPLOYMENTS_DIR)
            if os.path.isdir(os.path.join(DEPLOYMENTS_DIR, n))
        )
    return jsonify({
        'status': 'healthy',
        'service': 'Sycord Deployment Server',
        'instance': 'M1',
        'server_host': SERVER_HOST,
        'deployed_sites': deployed_count
    }), 200


@app.route('/deploy', methods=['GET', 'POST'])
def deploy_with_dns():
    """Deployment endpoint that builds a Vite project from a GitHub repo,
    deploys it to the sycord server, and creates a Cloudflare DNS CNAME
    record so the project is reachable at <project>.<CLOUDFLARE_DOMAIN>.

    Accepts GET query-string parameters or a POST JSON body:
      repo_id   (numeric str) – Numeric repository ID stored in MongoDB.  When
                         provided the server looks up git_url and git_token
                         automatically.  Mutually exclusive with the direct
                         git_url / git_token fields below.
      git_url   (str)  – Full GitHub repository URL, e.g.
                         https://github.com/owner/repo
      git_token (str)  – GitHub personal access token with repo read access.
      subdomain (str)  – Optional. Overrides the project/subdomain name
                         (defaults to the sanitised repo name).

    Success response:
    {
        "success": true,
        "message": "Deployment successful! Project: <name>",
        "project_name": "<name>",
        "url": "https://<name>.<CLOUDFLARE_DOMAIN>",
        "local_url": "/sites/<name>/",
        "custom_url": "https://<name>.<CLOUDFLARE_DOMAIN>",
        "dns_record_created": true,
        "output": "..."
    }
    """
    project_id_for_debug = None
    try:
        logger.info("Received deployment request at /deploy")

        # Accept parameters from GET query string or POST JSON body
        if request.method == 'GET':
            data = request.args.to_dict()
        else:
            data = request.get_json() or {}

        repo_id = data.get('repo_id')
        git_url = data.get('git_url')
        git_token = data.get('git_token')
        custom_subdomain = data.get('subdomain')

        # --- Option A: look up repo config from MongoDB using repo_id ---
        if repo_id:
            repo_id = str(repo_id)
            if not re.match(r'^\d+$', repo_id):
                return jsonify({
                    'success': False,
                    'message': 'Invalid repo_id format. Expected numeric identifier.'
                }), 400

            repo_doc = get_repo_by_id(repo_id)
            project_id_for_debug = repo_doc.get('project_id') if repo_doc else None

            if not repo_doc:
                return jsonify({
                    'success': False,
                    'message': f'Repository {repo_id} not found'
                }), 404

            git_token = repo_doc.get('git_token')
            git_url = repo_doc.get('git_url')

        # --- Validate required fields ---
        if not git_url:
            return jsonify({
                'success': False,
                'message': (
                    'git_url is required '
                    '(or provide a repo_id to look up from the database)'
                )
            }), 400

        if not git_token:
            return jsonify({
                'success': False,
                'message': (
                    'git_token is required '
                    '(or provide a repo_id to look up from the database)'
                )
            }), 400

        # --- Parse the GitHub URL ---
        owner, repo_name = parse_git_url(git_url)
        if not owner or not repo_name:
            return jsonify({
                'success': False,
                'message': f'Could not parse git_url: {git_url}'
            }), 400

        repo_full_name = f"{owner}/{repo_name}"
        project_name = sanitize_project_name(custom_subdomain or repo_name)

        # Set logging context
        tag = build_project_tag(repo_id or repo_name)
        log_token = current_project_tag.set(tag)

        try:
            # 1. Download repository from GitHub
            temp_dir = download_github_repo(git_token, repo_full_name, 'main')

            if not temp_dir:
                return deployment_error_response(
                    'Failed to download repository from GitHub',
                    status_code=500,
                    project_id=project_id_for_debug
                )

            try:
                # 2. Build and deploy to sycord server
                result = deploy_to_sycord(temp_dir, project_name)

                if not result['success']:
                    return deployment_error_response(
                        'Deployment to sycord server failed',
                        error=result.get('error'),
                        status_code=500,
                        project_id=project_id_for_debug
                    )

                # 3. Create a Cloudflare DNS CNAME record pointing to this
                #    server (skipped when CLOUDFLARE_ZONE_ID is not configured)
                dns_result = None
                custom_url = None

                if CLOUDFLARE_ZONE_ID:
                    dns_result = create_cloudflare_dns_record(project_name, SERVER_HOST)
                    if dns_result:
                        custom_url = dns_result.get('url')
                else:
                    logger.warning(
                        "CLOUDFLARE_ZONE_ID not set – skipping DNS record creation"
                    )

                return jsonify({
                    'success': True,
                    'message': f'Deployment successful! Project: {project_name}',
                    'project_name': project_name,
                    'url': result.get('url'),
                    'local_url': result.get('local_url'),
                    'custom_url': custom_url,
                    'dns_record_created': dns_result is not None,
                    'output': result.get('output')
                }), 200

            finally:
                shutil.rmtree(temp_dir, ignore_errors=True)
                logger.info(f"Cleaned up temporary directory: {temp_dir}")
        finally:
            current_project_tag.reset(log_token)

    except Exception as e:
        logger.error(f"Deploy error: {e}")
        return deployment_error_response(
            'Deployment failed',
            error=str(e),
            status_code=500,
            project_id=project_id_for_debug
        )


if __name__ == '__main__':
    # Check if required environment variables are set or still at defaults
    config_warnings = []

    # Cloudflare credentials are optional (only needed for DNS)
    if not CLOUDFLARE_API_TOKEN:
        config_warnings.append("CLOUDFLARE_API_TOKEN not set – DNS record creation disabled")
    if not CLOUDFLARE_ZONE_ID:
        config_warnings.append("CLOUDFLARE_ZONE_ID not set – DNS record creation disabled")

    # Check for default placeholder values
    defaults = {
        "MONGO_URI": "mongodb+srv://user:password@cluster.mongodb.net/?appName=Cluster"
    }

    config_errors = []
    for key, default_val in defaults.items():
        val = os.getenv(key)
        if val == default_val:
            config_errors.append(f"{key} is still set to the default placeholder: '{default_val}'")

    if config_errors:
        logger.error("Configuration Error: The application is not properly configured.")
        for error in config_errors:
            logger.error(f"- {error}")
        logger.error("Please edit the .env file with your actual credentials.")
        exit(1)

    for warning in config_warnings:
        logger.warning(warning)

    logger.info(f"Deployments directory: {DEPLOYMENTS_DIR}")
    logger.info(f"Server host: {SERVER_HOST}")

    # Run Flask app
    port = int(os.getenv('PORT', 5000))
    debug = os.getenv('DEBUG', 'False').lower() == 'true'

    logger.info(f"Starting Sycord Deployment Server on port {port}")
    app.run(host='0.0.0.0', port=port, debug=debug)
