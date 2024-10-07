const Redis = require('ioredis');
require('dotenv').config();
const redis = require("redis")
const { exec } = require('child_process');
const fs = require('fs');


// Constantes
const REDIS_SERVER = 'redis://79.143.185.100:6379';

// Fonction de création et connexion de client Redis
const createRedisClient = (url) => {
  const client = redis.createClient({ url });
  client.connect().catch(console.error);
  client.on("error", (err) => console.error("Redis error:", err));
  client.on("connect", () => console.log("Connected to Redis"));
  client.on("ready", () => console.log("Redis client is ready to use"));
  return client;
};

// Configuration Redis
const _redisClient_get = createRedisClient(REDIS_SERVER);

// Vérifier que REDIS_SERVER est défini
if (!REDIS_SERVER) {
  console.error('REDIS_SERVER n\'est pas défini dans les variables d\'environnement');
  process.exit(1);
}

// Créer le client Redis pour les abonnements
const redisClient = new Redis(REDIS_SERVER);

// Abonner aux événements de cléspace
/* redisClient.psubscribe('__keyspace@0__:*', (err, count) => {
  if (err) {
    console.error('Erreur lors de l\'abonnement aux événements de changement de clé:', err);
    return;
  }
  console.log(`Abonné à ${count} canaux pour les événements de changement de clé`);
}); */

// Écouter les événements de changement de clé
redisClient.on('pmessage', async (pattern, channel, message) => {
  if (`${channel.split(":")[1]}` === "area-geofence-configs" && message != "del") {
    console.log("Lancement des services")
    await initializeInstances()
  }
  else if (`${channel.split(":")[1]}` === "area-geofence-configs" && message === "del") {
    console.log("Stopage des services en cours")


    fs.writeFile('ecosystem.config.json', "No data", 'utf8', (err) => {
      if (err) {
        console.error('Error writing file:', err);
      }
    });
  }

});

redisClient.on('error', (err) => {
  console.error('Erreur de Redis:', err);
});

const getAreaConfigsFromRedis = async () => {
  try {
    const areaConfigs = await _redisClient_get.lRange("area-geofence-configs", 0, -1);
    return areaConfigs.map(JSON.parse);
  } catch (error) {
    console.error("Error reading area configs from Redis:", error);
    throw error;
  }
};

const initializeInstances = async () => {
  try {
    const data = await getAreaConfigsFromRedis();
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
};