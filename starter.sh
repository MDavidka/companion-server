#!/bin/bash

# ============================================
# Sycord M1 Instance - Auto Deploy Starter
# This script sets up and runs the deployment server
# ============================================

set -euo pipefail

echo "╔════════════════════════════════════════════════════════════╗"
echo "║          Sycord M1 Instance - Deployment Server            ║"
echo "║              Auto Deploy Starter Script                     ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored messages
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    print_warning "Running as root. Consider running as a regular user."
fi

# Step 1: Check for Node.js and npm
print_status "Checking Node.js installation..."
INSTALL_NODE=true

if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v)
    # Extract major version
    NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d'v' -f2 | cut -d'.' -f1)

    if [ "$NODE_MAJOR" -ge 18 ]; then
        print_success "Node.js found: $NODE_VERSION"
        INSTALL_NODE=false
    else
        print_warning "Node.js found ($NODE_VERSION) but is older than v18. Updating..."
    fi
else
    print_warning "Node.js not found. Installing Node.js..."
fi

if [ "$INSTALL_NODE" = true ]; then
    # Check OS and install Node.js
    if [ "$(uname)" == "Darwin" ]; then
        # macOS
        if command -v brew &> /dev/null; then
            print_status "Upgrading/Installing Node.js via Homebrew..."
            brew install node || brew upgrade node
        else
            print_error "Please install Homebrew first: https://brew.sh/"
            exit 1
        fi
    elif [ -f /etc/debian_version ] || [ -f /etc/redhat-release ]; then
        # Linux (Debian/Ubuntu/RHEL/CentOS)
        if command -v sudo &> /dev/null; then
            print_status "Installing Node.js via package manager..."
            if [ -f /etc/debian_version ]; then
                curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
                sudo apt-get install -y nodejs
            elif [ -f /etc/redhat-release ]; then
                curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
                sudo yum install -y nodejs
            fi
        else
            print_warning "sudo not found. Attempting to install Node.js locally..."

            # Detect architecture
            ARCH=$(uname -m)
            if [ "$ARCH" == "x86_64" ]; then
                NODE_ARCH="x64"
            elif [ "$ARCH" == "aarch64" ] || [ "$ARCH" == "arm64" ]; then
                NODE_ARCH="arm64"
            else
                print_error "Unsupported architecture for local install: $ARCH"
                exit 1
            fi

            # Install Node.js locally
            NODE_VERSION_INSTALL="v20.11.1"
            NODE_DIST="node-$NODE_VERSION_INSTALL-linux-$NODE_ARCH"
            NODE_URL="https://nodejs.org/dist/$NODE_VERSION_INSTALL/$NODE_DIST.tar.xz"

            # Clean up old local install if it exists
            rm -rf .node

            mkdir -p .node
            print_status "Downloading Node.js from $NODE_URL..."
            if curl -fsSL "$NODE_URL" | tar -xJ -C .node --strip-components=1; then
                export PATH="$PWD/.node/bin:$PATH"
                print_success "Node.js installed locally in .node/"
            else
                print_error "Failed to download/install Node.js locally."
                exit 1
            fi
        fi
    else
        print_error "Unsupported OS. Please install Node.js v20+ manually."
        exit 1
    fi
    
    # Verify installation
    if command -v node &> /dev/null; then
         print_success "Node.js installed: $(node --version)"
    else
         print_error "Node.js installation verification failed."
         exit 1
    fi
fi

# Step 2: Check for npm
print_status "Checking npm installation..."
if command -v npm &> /dev/null; then
    print_success "npm found: $(npm --version)"
else
    print_error "npm not found. Please install npm."
    exit 1
fi

# Step 3: Install Node dependencies
print_status "Installing Node dependencies..."
if ! npm install; then
    print_error "Failed to install Node dependencies"
    exit 1
fi
print_success "Node dependencies installed"

# Step 4: Check for .env file
print_status "Checking environment configuration..."
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        print_warning ".env file not found. Copying from .env.example..."
        cp .env.example .env
        print_warning "Please edit .env file with your configuration before running."
        echo ""
        echo "Required configuration:"
        echo "  - MONGO_URI: MongoDB connection string"
        echo "  - MONGO_DB: Database name (default: main)"
        echo "  - MONGO_COLLECTION: Collection name (default: users)"
        echo "  - CLOUDFLARE_API_TOKEN: Cloudflare API token (optional, for DNS record creation)"
        echo "  - CLOUDFLARE_ZONE_ID: Cloudflare zone ID (optional, for DNS record creation)"
        echo ""
    else
        print_error ".env file not found and .env.example is missing."
        exit 1
    fi
else
    print_success "Environment configuration found"
fi

# Check for default values in .env
if grep -q "your_cloudflare_api_token" .env || \
   grep -q "mongodb+srv://user:password@cluster.mongodb.net/?appName=Cluster" .env; then

    print_error "Default configuration values detected in .env!"
    echo "The application cannot run with the placeholder values."
    echo "Please edit the .env file with your actual credentials."
    echo "  - CLOUDFLARE_API_TOKEN (if DNS record creation is needed)"
    echo "  - MONGO_URI"
    exit 1
fi

# Step 5: Start the server
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                   Starting M1 Instance                      ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

print_status "Starting Sycord Deployment Server..."
print_status "Access the UI at: http://localhost:${PORT:-4500}"
echo ""

# Run the Node application
npm start
