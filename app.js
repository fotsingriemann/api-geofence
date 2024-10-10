const axios = require('axios');
const { polygon, point, booleanPointInPolygon } = require('@turf/turf');
const fs = require('fs');
const redis = require('redis');
require('dotenv').config();

// URL de votre serveur GraphQL
const GRAPHQL_URL = "https://api.dev.eneotransportation.com";
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Configuration des données d'aire
const aoi = process.env.AOI ? JSON.parse(process.env.AOI) : null;
console.log(aoi)
const aoi_id = aoi.areaId[0].id; // Assurez-vous que l'ID de l'aire est disponible
const aoi_name = aoi.areaId[0].name;
const uniqueDeviceIds = aoi.uniqueDeviceId.map(deviceId => ({
    ...deviceId,
    aoi_name: aoi_name
}));
const meta_data = JSON.parse(aoi.areaId[0].meta_data);

const query2 = `
  query getLatestLocation($uniqueId: String!) {
    getDeviceLatestLocation(deviceId: $uniqueId) {
      timestamp
      latitude
      longitude
      haltStatus
      idlingStatus
      isOverspeed
      speed
      extBatVol
      isPrimaryBattery
      isNoGps
      address
      __typename
    }
  }
`;


const postDataToOdoo = async (url, jsonData) => {
    const headers = {
        'Content-Type': 'application/json',
    };

    try {
        const response = await axios.post(url, jsonData, { headers });
        return response.data;
    } catch (error) {
        await logError(`Error posting data to Odoo: ${error}`);
        throw error;
    }
};

const updateDataToOdoo = async (url, jsonData) => {
    const headers = {
        'Content-Type': 'application/json',
    };

    try {
        const response = await axios.put(url, jsonData, { headers });
        return response.data;
    } catch (error) {
        await logError(`Error updating data to Odoo: ${error}`);
        throw error;
    }
};


const executeGraphQL = async (query, variables = {}, token = null) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    try {
        const response = await axios.post(GRAPHQL_URL, { query, variables }, { headers });
        return response.data;
    } catch (error) {
        console.error('GraphQL request error:', error);
        throw error;
    }
};

function closePolygon(coordinates) {
    if (coordinates.length === 0) return coordinates;

    const firstPoint = coordinates[0];
    const lastPoint = coordinates[coordinates.length - 1];

    if (firstPoint[0] !== lastPoint[0] || firstPoint[1] !== lastPoint[1]) {
        coordinates.push(firstPoint);
    }

    return coordinates;
}

function invertCoordinates(coordinates) {
    return coordinates.map(([lat, lng]) => [lng, lat]);
}

const points = meta_data;
const invertedPoints = invertCoordinates(points);
const closedPoints = closePolygon(invertedPoints);
const geofence = polygon([closedPoints]);

const logToFile = (message, filePath) => {
    const logMessage = `${new Date().toISOString()} - ${message}\n`;
    try {
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, logMessage);
        } else {
            fs.appendFileSync(filePath, logMessage);
        }
    } catch (err) {
        console.error(`Error writing to log file ${filePath}:`, err);
    }
};

// Connexion à Redis
const redisClient = redis.createClient({ url: REDIS_URL });
redisClient.connect();

const logDeviceEvent = async (uniqueId, aoiId, eventMessage) => {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ${eventMessage}`;
    await redisClient.lPush(`deviceEvents:${uniqueId}:${aoiId}`, logMessage);
    logToFile(logMessage, 'geofence.log');
};

const checkLocation = async (uniqueId, aoiId, token) => {
    const variables2 = { uniqueId: uniqueId };
    try {
        const result2 = await executeGraphQL(query2, variables2, token);
        const latestLocation = result2.data.getDeviceLatestLocation;

        const pointToCheck = point([latestLocation.longitude, latestLocation.latitude]);
        const isInside = booleanPointInPolygon(pointToCheck, geofence);

        const previousState = await redisClient.get(`deviceState:${uniqueId}:${aoiId}`);
        const coordinates = pointToCheck.geometry.coordinates;

        // Log message to indicate point entry or exit
        const logMessage = `Device ${uniqueId}: Point ${isInside ? 'entered' : 'exited'} geofence at ${coordinates[1]},${coordinates[0]} in ${aoi_name}`;

        if (previousState === null && isInside) {
            // Enregistrement de l'entrée dans la zone
            let jsonData = {
                clientid: '1172',
                uniqueid: uniqueId,
                aoiid: aoiId,
                aoiname: aoi_name,
                alerttype: 'AOI',
                alertvalue: 'PARKING',
                alert_completed: 0,
                from_ts: latestLocation.timestamp,
                to_ts: latestLocation.timestamp,
                from_lat: latestLocation.latitude,
                from_lng: latestLocation.longitude,
                to_lat: latestLocation.latitude,
                to_lng: latestLocation.longitude,
                pluscode: latestLocation.timestamp,
                vehiclenumber: uniqueId,
            };
            await postDataToOdoo('https://dev.support.africasystems.com/api/create/alert', jsonData);
            await logDeviceEvent(uniqueId, aoiId, logMessage);
            await redisClient.set(`deviceState:${uniqueId}:${aoiId}`, JSON.stringify(isInside));
        } else if (previousState !== null && JSON.parse(previousState) !== isInside) {

            let jsonData = {
                clientid: '1172',
                aoiid: aoiId,
                aoiname: aoi_name,
                alerttype: 'AOI',
                alertvalue: 'PARKING',
                alert_completed: 0,
                from_ts: latestLocation.timestamp,
                to_ts: latestLocation.timestamp,
                from_lat: latestLocation.latitude,
                from_lng: latestLocation.longitude,
                to_lat: latestLocation.latitude,
                to_lng: latestLocation.longitude,
                pluscode: latestLocation.timestamp,
                vehiclenumber: uniqueId,
                uniqueid: uniqueId,
                areaid: aoiId,
                fromTimestamp: latestLocation.timestamp,

            };
            await updateDataToOdoo('https://dev.support.africasystems.com/api/update/alert', jsonData);
            // Enregistrement de la sortie de la zone ou changement d'état
            await logDeviceEvent(uniqueId, aoiId, logMessage);
            await redisClient.set(`deviceState:${uniqueId}:${aoiId}`, JSON.stringify(isInside));
        }

        // Mise à jour des positions du dispositif
        const devicePositionsKey = `devicePositions:${uniqueId}:${aoiId}`;
        const devicePositions = await redisClient.get(devicePositionsKey);
        const updatedPositions = devicePositions ? JSON.parse(devicePositions) : [];
        updatedPositions.push({
            latitude: latestLocation.latitude,
            longitude: latestLocation.longitude,
            timestamp: latestLocation.timestamp,
        });
        await redisClient.set(devicePositionsKey, JSON.stringify(updatedPositions));

    } catch (error) {
        console.error(`Error checking location for device ${uniqueId}:`, error);
    }
};

const initialCheckLocations = async (deviceIds, token) => {
    for (const item of deviceIds) {
        await checkLocation(item.location, aoi_id, token);
    }
};

const main = async () => {
    try {
        const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJsb2dpbklkIjoxMTE3LCJ1c2VybmFtZSI6ImFmcmljdHJhY2siLCJyb2xlcyI6IkNMSUVOVCIsImlhdCI6MTcyODA0MTk4M30.Om6mPpC79R71T27Vng5H-aqpaZUVRUdeJuNUGtoRKMk"

        // Vérification initiale des dispositifs
        await initialCheckLocations(uniqueDeviceIds, token);

        const checkInterval = 4000; // Intervalle de vérification en millisecondes

        uniqueDeviceIds.forEach(item => {
            setInterval(async () => {
                await checkLocation(item.location, aoi_id, token);
            }, checkInterval);
        });

    } catch (error) {
        console.error('Error:', error);
    }
};

main();
