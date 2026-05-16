const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/';
const MONGO_DB = process.env.MONGO_DB || 'main';
const MONGO_COLLECTION = process.env.MONGO_COLLECTION || 'users';

let client;

async function getMongoClient() {
  if (!client) {
    client = new MongoClient(MONGO_URI);
    await client.connect();
  }
  return client;
}

async function getAllUsersWithRepos() {
  const dbClient = await getMongoClient();
  const db = dbClient.db(MONGO_DB);
  const collection = db.collection(MONGO_COLLECTION);
  
  const users = await collection.find(
    { git_connection: { $exists: true } },
    { projection: { username: 1, git_connection: 1 } }
  ).toArray();
  
  return users;
}

async function getRepoById(repoId) {
  const users = await getAllUsersWithRepos();
  const repoIdStr = String(repoId);

  for (const user of users) {
    const username = user.username;
    const git_connection = user.git_connection || {};

    if (typeof git_connection === 'object' && !Array.isArray(git_connection)) {
      if (repoIdStr in git_connection) {
        const repo = { ...git_connection[repoIdStr] };
        repo.username = repo.username || username;
        repo.repo_id = repo.repo_id || repoIdStr;
        return repo;
      }
    } else if (Array.isArray(git_connection)) {
      for (const repo of git_connection) {
        if (String(repo.repo_id || '') === repoIdStr) {
          const repoWithUser = { ...repo };
          repoWithUser.username = repoWithUser.username || username;
          repoWithUser.repo_id = repoWithUser.repo_id || repoIdStr;
          return repoWithUser;
        }
      }
    }
  }

  return null;
}

async function getRepositoryDocuments(includeTokens = false) {
  const users = await getAllUsersWithRepos();
  const allRepos = [];
  
  for (const user of users) {
    const username = user.username || 'unknown';
    const git_connection = user.git_connection || {};
    
    let repos = [];
    if (typeof git_connection === 'object' && !Array.isArray(git_connection)) {
      repos = Object.values(git_connection);
    } else {
      repos = git_connection;
    }
    
    for (const repo of repos) {
      const repoDoc = {
        username: username,
        repo_id: repo.repo_id,
        git_url: repo.git_url,
        repo_name: repo.repo_name,
      };
      if (includeTokens) {
        repoDoc.git_token = repo.git_token;
      }
      allRepos.push(repoDoc);
    }
  }
  
  return allRepos;
}

async function getUserRepos(username) {
  const dbClient = await getMongoClient();
  const db = dbClient.db(MONGO_DB);
  const collection = db.collection(MONGO_COLLECTION);
  
  const userDoc = await collection.findOne(
    { username: username },
    { projection: { git_connection: 1 } }
  );
  
  if (userDoc && userDoc.git_connection) {
    const git_connection = userDoc.git_connection;
    if (typeof git_connection === 'object' && !Array.isArray(git_connection)) {
      return Object.values(git_connection);
    } else {
      return git_connection;
    }
  }
  
  return [];
}

module.exports = {
  getMongoClient,
  getAllUsersWithRepos,
  getRepoById,
  getRepositoryDocuments,
  getUserRepos
};
