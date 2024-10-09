require("dotenv").config();
const { Client } = require('pg');
const axios = require("axios");
const redis = require('redis');
const fs = require('fs');


const ODOO_URL = 'https://dev.support.africasystems.com';
const REDIS_SERVER = 'redis://79.143.185.100:6379';

// Vérifier que REDIS_SERVER est défini
if (!REDIS_SERVER) {
  console.error('REDIS_SERVER n\'est pas défini dans les variables d\'environnement');
  process.exit(1);
}

const createRedisClient = (url) => {
  console.log('Connecting to Redis at:', url); // Log the Redis URL
  const client = redis.createClient({ url });
  client.connect().catch(console.error);
  client.on("error", (err) => console.error("Redis error:", err));
  client.on("connect", () => console.log("Connected to Redis"));
  client.on("ready", () => console.log("Redis client is ready to use"));
  return client;
};

// Configuration Redis
const redisClient = createRedisClient(REDIS_SERVER);

// Configuration de la connexion
const client = new Client({
  user: 'odoo', // replace with your database user
  host: '20.197.12.183', // replace with your database host
  database: 'support_erp_db', // replace with your database name
  password: '21OxGK0ml6UNNDJylyitaJqbYowmYIAgsXA4HDb4', // replace with your database password
  port: 5432, // default PostgreSQL port
});

client.connect()
  .then(async () => {
    console.log('Connected to PostgreSQL');
    await performAction()
    client.query('LISTEN geofence_insert');

  })
  .catch(err => console.error('Connection error', err.stack));

// Écouter les notifications
client.on('notification', async (msg) => {
  if (msg.channel === 'geofence_insert') {
    console.log('New insertion:');
    // Effectuer une action ici
    await performAction();
  }
});

async function performAction() {
  // Votre logique pour traiter les données insérées
  console.log("ici");
  const newResponse = await axios.get(
    `${ODOO_URL}/api/search/area-configs`,
    {

    }
  );
  console.log(newResponse);
  const newAreaConfig = newResponse.data;
  if (newAreaConfig.success && newAreaConfig.data) {
    const data = newAreaConfig.data;
    console.log(data);

    const keyExists = await redisClient.exists("area-geofence-configs");

    if (keyExists) {
      await redisClient.del("area-geofence-configs");
    }

    for (const areaConf of data) {
      await redisClient.rPush("area-geofence-configs", JSON.stringify(areaConf));

    }

    try {
      const instances = data.map((areaConf, i) => ({
        name: areaConf.areaId[0].name,
        script: "./app.js",
        instances: 1,
        autorestart: true,
        max_restarts: 10,
        exec_mode: "fork",
        env: {
          NODE_ENV: "development",
          PORT: `${5000 + i}`,
          AOI: JSON.stringify(areaConf),
          AOI_ID: areaConf.areaId[0].id
        }
      }));

      // Convertir la variable en JSON
      const jsonData = JSON.stringify(instances, null, 2);

      // Écrire la variable dans un fichier de manière asynchrone
      fs.writeFile('ecosystem.config.json', jsonData, 'utf8', (err) => {
        if (err) {
          console.error('Error writing file:', err);
        }
      });


    } catch (error) {
      console.error("Error initializing instances:", error);
    }
    console.log("Updated Successfully");
  } else {
    console.log("Faute");
  }
}

// Gérer les erreurs
client.on('error', (err) => {
  console.error('Error:', err);
});