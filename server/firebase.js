const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const b64 = process.env.GCP_SA_KEY_B64;
if (!b64) {
  throw new Error('GCP_SA_KEY_B64 ausente');
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
} catch (err) {
  throw new Error(`Falha ao decodificar GCP_SA_KEY_B64: ${err.message}`);
}

const projectId = process.env.GCP_PROJECT_ID || serviceAccount.project_id;
if (!projectId) {
  throw new Error('project_id ausente nas credenciais do Firebase');
}

const app = getApps().length
  ? getApps()[0]
  : initializeApp({
      credential: cert(serviceAccount),
      projectId,
    });

const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });

module.exports = { db, firebaseProjectId: projectId };
