# Use an official Python runtime as a parent image
FROM python:3.11-slim

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=5000

# Set work directory
WORKDIR /app

# Install system dependencies
# curl, gnupg, ca-certificates are needed for installing Node.js
# git is often needed by npm install for some dependencies
# unzip is useful for debugging or manual operations
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    gnupg \
    ca-certificates \
    git \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js (LTS version 20) – required for npm install and npm run build
# We use the NodeSource setup script to get the latest Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm cache clean --force

# Verify installations
RUN node --version && npm --version

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Expose the port the app runs on
EXPOSE 5000

# Run the application
CMD ["python", "app.py"]
