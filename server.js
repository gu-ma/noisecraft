// node-sqlite3 API:
// https://github.com/mapbox/node-sqlite3/wiki/API
import express from 'express';
import path from 'path'
import fs from 'fs';
import bodyParser from 'body-parser';
import sqlite3 from 'sqlite3';
import crc from 'crc';
import crypto from 'crypto';
import ejs from 'ejs';
import { WebSocketServer } from 'ws';

// Load the model so we can validate projects
import * as model from './public/model.js';

// Initializing application configuration parameters
const dbFilePath = process.env.DB_FILE_PATH || './database.db';
const serverHTTPPortNo = process.env.HTTP_PORT_NO  || 7773;

var app = express();


// Basic in-memory clock sessions for network sync
const clockSessions = new Map();

function getClockSession(sessionId)
{
    if (!clockSessions.has(sessionId))
        clockSessions.set(sessionId, { sockets: new Set(), host: null });
    return clockSessions.get(sessionId);
}

// Create application/json parser
var jsonParser = bodyParser.json({limit: '1mb'});


const openRouterAPIURL = 'https://openrouter.ai/api/v1/chat/completions';

function extractMessageText(message, choice = null, data = null)
{
    if (!message)
        return '';

    if (typeof message.content === 'string')
        return message.content;

    if (message.content instanceof Array)
    {
        let parts = message.content
            .map(part => (typeof part?.text == 'string')? part.text:'')
            .filter(Boolean);

        if (parts.length)
            return parts.join('\n').trim();
    }

    if (typeof choice?.text === 'string' && choice.text.trim())
        return choice.text.trim();

    if (typeof data?.output_text === 'string' && data.output_text.trim())
        return data.output_text.trim();

    return '';
}


async function promptOpenRouter(messages, options = {})
{
    let apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey)
        throw TypeError('missing OPENROUTER_API_KEY');

    if (!(messages instanceof Array) || messages.length == 0)
        throw TypeError('messages must be a non-empty array');

    let modelName = options.model || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
    let maxTokens = options.maxTokens || 1400;
    let temperature = options.temperature ?? 0.4;

    async function callOpenRouter(useJSONFormat)
    {
        let payload = {
            model: modelName,
            messages: messages,
            temperature: temperature,
            max_tokens: maxTokens,
        };

        if (useJSONFormat)
            payload.response_format = { type: 'json_object' };

        let response = await fetch(openRouterAPIURL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                ...(process.env.OPENROUTER_SITE_URL? { 'HTTP-Referer': process.env.OPENROUTER_SITE_URL }: {}),
                ...(process.env.OPENROUTER_SITE_NAME? { 'X-Title': process.env.OPENROUTER_SITE_NAME }: {}),
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok)
        {
            let errText = await response.text();
            throw TypeError(`openrouter error (${response.status}): ${errText.slice(0, 300)}`);
        }

        let data = await response.json();
        let choice = data?.choices?.[0] || null;
        let msg = extractMessageText(choice?.message, choice, data);

        return { data, msg };
    }

    let { data, msg } = await callOpenRouter(true);

    // Some models/providers don't support response_format reliably.
    if (!msg)
        ({ data, msg } = await callOpenRouter(false));


    // Fallback to a known-good model if configured model produced no text
    if (!msg)
    {
        let fallbackModel = process.env.OPENROUTER_FALLBACK_MODEL || 'openai/gpt-4o-mini';
        if (modelName != fallbackModel)
        {
            let prevModel = modelName;
            modelName = fallbackModel;
            ({ data, msg } = await callOpenRouter(false));
            if (msg)
                data.model = data.model || fallbackModel;
            modelName = prevModel;
        }
    }

    if (!msg)
        throw TypeError('openrouter returned empty message');

    return {
        model: data.model || modelName,
        content: msg,
        usage: data.usage || null,
    };
}


function getLLMNodeCatalog()
{
    let catalog = {};

    for (let nodeType in model.NODE_SCHEMA)
    {
        let schema = model.NODE_SCHEMA[nodeType];

        if (schema.internal)
            continue;

        catalog[nodeType] = {
            ins: schema.ins.map(input => input.name),
            outs: schema.outs,
            params: schema.params.map(param => ({
                name: param.name,
                default: param.default,
            })),
            description: schema.description || '',
            unique: Boolean(schema.unique),
        };
    }

    return catalog;
}



function parseGeneratedProjectText(text)
{
    // Try direct parse first
    try
    {
        return JSON.parse(text);
    }
    catch (e)
    {
        // continue with salvage attempts
    }

    // Remove markdown fences if present
    let cleaned = text
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();

    try
    {
        return JSON.parse(cleaned);
    }
    catch (e)
    {
        // continue
    }

    // Extract the largest object-looking slice
    let first = cleaned.indexOf('{');
    let last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first)
    {
        let slice = cleaned.slice(first, last + 1);
        return JSON.parse(slice);
    }

    throw SyntaxError('failed to parse generated JSON');
}


async function parseOrRepairGeneratedProject(text, modelName)
{
    try
    {
        return parseGeneratedProjectText(text);
    }
    catch (e)
    {
        let repairPrompt = `Fix this malformed JSON and return ONLY valid JSON. Keep the same semantic content and do not add markdown:
${text}`;

        let repaired = await promptOpenRouter([
            { role: 'system', content: 'You are a JSON repair assistant. Return JSON only.' },
            { role: 'user', content: repairPrompt },
        ], {
            model: modelName,
            temperature: 0,
            maxTokens: 2000,
        });

        return parseGeneratedProjectText(repaired.content);
    }
}

function coerceGeneratedProject(project)
{
    if (!(project instanceof Object))
        throw TypeError('generated project must be an object');

    if (typeof project.title != 'string')
        project.title = 'Generated Patch';

    if (!(project.nodes instanceof Object))
        throw TypeError('generated project missing nodes');

    let outNodes = {};
    let outId = 0;

    for (let nodeId in project.nodes)
    {
        let node = project.nodes[nodeId];
        if (!(node instanceof Object))
            continue;

        if (typeof node.type != 'string' || !(node.type in model.NODE_SCHEMA))
            continue;

        let schema = model.NODE_SCHEMA[node.type];
        if (schema.internal)
            continue;

        let outNode = {
            type: node.type,
            name: (typeof node.name == 'string' && node.name.length)? node.name.slice(0, 12):node.type,
            x: Number.isFinite(node.x)? Math.round(node.x):0,
            y: Number.isFinite(node.y)? Math.round(node.y):0,
            ins: Array(schema.ins.length).fill(null),
            inNames: schema.ins.map(input => input.name),
            outNames: schema.outs.map(name => name),
            params: {},
        };

        for (let param of schema.params)
        {
            let val = node.params?.[param.name];
            outNode.params[param.name] = (val === undefined)? param.default:val;
        }

        // preserve valid schema state fields when present
        let stateFields = schema.state || [];
        for (let key of stateFields)
        {
            if (key in node)
                outNode[key] = node[key];
        }

        outNodes[String(outId)] = outNode;
        outId += 1;
    }

    // map old IDs to new IDs in insertion order
    let oldIds = Object.keys(project.nodes);
    let idMap = {};
    let keptOldIds = [];
    for (let oldId of oldIds)
    {
        let oldNode = project.nodes[oldId];
        if (!(oldNode instanceof Object) || typeof oldNode.type != 'string')
            continue;
        if (!(oldNode.type in model.NODE_SCHEMA) || model.NODE_SCHEMA[oldNode.type].internal)
            continue;
        idMap[oldId] = String(keptOldIds.length);
        keptOldIds.push(oldId);
    }

    // reconnect inputs
    for (let newId in outNodes)
    {
        let oldId = keptOldIds[Number(newId)];
        let oldNode = project.nodes[oldId];
        let newNode = outNodes[newId];

        for (let i = 0; i < newNode.ins.length; ++i)
        {
            let inRef = oldNode.ins?.[i];
            if (!(inRef instanceof Array) || inRef.length != 2)
                continue;

            let srcOldId = String(inRef[0]);
            let outIdx = Number(inRef[1]);
            let srcNewId = idMap[srcOldId];
            if (srcNewId === undefined)
                continue;

            let srcNode = outNodes[srcNewId];
            if (!Number.isInteger(outIdx) || outIdx < 0 || outIdx >= srcNode.outNames.length)
                continue;

            newNode.ins[i] = [srcNewId, outIdx];
        }
    }

    project.nodes = outNodes;
    return project;
}


function autoConnectGeneratedProject(project)
{
    let nodeIds = Object.keys(project.nodes);
    if (!nodeIds.length)
        return;

    let hasConnection = false;
    for (let nodeId of nodeIds)
    {
        let node = project.nodes[nodeId];
        if (node.ins.some(input => input !== null))
        {
            hasConnection = true;
            break;
        }
    }

    if (hasConnection)
        return;

    let audioOutId = null;
    for (let nodeId of nodeIds)
    {
        if (project.nodes[nodeId].type == 'AudioOut')
        {
            audioOutId = nodeId;
            break;
        }
    }

    let synthNodes = nodeIds
        .filter(nodeId => nodeId != audioOutId)
        .filter(nodeId => project.nodes[nodeId].outNames.length > 0)
        .sort((a, b) => project.nodes[a].x - project.nodes[b].x);

    for (let i = 1; i < synthNodes.length; ++i)
    {
        let srcId = synthNodes[i - 1];
        let dstId = synthNodes[i];
        let dst = project.nodes[dstId];

        if (dst.ins.length > 0)
            dst.ins[0] = [srcId, 0];
    }

    if (audioOutId !== null && synthNodes.length)
    {
        let srcId = synthNodes[synthNodes.length - 1];
        let out = project.nodes[audioOutId];

        if (out.ins.length > 0)
            out.ins[0] = [srcId, 0];
        if (out.ins.length > 1)
            out.ins[1] = [srcId, 0];
    }
}

function buildNoiseCraftSystemPrompt()
{
    let nodeCatalog = JSON.stringify(getLLMNodeCatalog());

    return (
        'You are a NoiseCraft patch generator. Return JSON only, no markdown. '        + 'The response must be a valid project object with exactly keys "title" and "nodes". '        + 'Use only node types present in this catalog: ' + nodeCatalog + '. '        + 'Each node must include: type, name, x, y, ins, inNames, outNames, params. '        + 'Node IDs must be numeric strings like "0", "1". '        + 'Connections in ins must be null or ["sourceNodeId", outputPortIndex]. '        + 'Do not include internal nodes or extra properties. '        + 'Always include one AudioOut node and connect audible signal to both left and right inputs.'
    );
}

// Connect to the database
async function connectDb(dbFilePath)
{
    return new Promise((resolve, reject) => {
        let db = new sqlite3.Database(dbFilePath, (err) =>
        {
            if (err)
                return reject();

            console.log('connected to the database');
            return resolve(db);
        })
    })
}

// Wait until we're connected to the database
let db = await connectDb(dbFilePath);

// Setup the database tables
db.run(`CREATE table IF NOT EXISTS hits (
    time UNSIGNED BIGINT,
    ip STRING NOT NULL);`
);
db.run(`CREATE table IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    title TEXT NOT NULL,
    data BLOB,
    crc32 UNSIGNED INT,
    featured UNSIGNED INT DEFAULT 0,
    submit_time BIGINT,
    submit_ip STRING NOT NULL);`
);
db.run(`CREATE table IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    email TEXT,
    pwd_hash TEXT NOT NULL,
    pwd_salt TEXT NOT NULL,
    reg_time BIGINT,
    reg_ip STRING NOT NULL,
    access STRING NOT NULL DEFAULT 'default');`
);
db.run(`CREATE table IF NOT EXISTS sessions (
    user_id INTEGER,
    session_id TEXT NOT NULL,
    login_ip STRING NOT NULL,
    login_time BIGINT);`
);

// Get the IP address of a client as a string
function getClientIP(req)
{
    var headers = req.headers;

    if ('x-real-ip' in headers)
    {
        return String(headers['x-real-ip']);
    }

    return String(req.connection.remoteAddress);
}

function recordHit(req) {
    db.run(
        'INSERT INTO hits VALUES (?, ?);',
        Date.now(),
        getClientIP(req)
    );
}

// Hash a string using SHA512
function cryptoHash(str)
{
    let hash = crypto.createHash('sha512');
    let data = hash.update(str, 'utf-8');
    let hash_str = data.digest('base64');
    return hash_str;
}

/**
Add a new user to the database
Note: this function does not check for duplicates
*/
async function addUser(username, password, email, ip)
{
    // TODO: assert valid characters only, no whitespace at start or end

    let pwd_salt = String(Date.now()) + String(Math.random());
    let pwd_hash = cryptoHash(password + pwd_salt);
    let reg_time = Date.now()

    // Insert the user into the database
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT INTO users ' +
            '(username, email, pwd_hash, pwd_salt, reg_time, reg_ip) ' +
            'VALUES (?, ?, ?, ?, ?, ?);',
            [username, email, pwd_hash, pwd_salt, reg_time, ip],
            function (err)
            {
                if (err)
                {
                    reject(err);
                    return;
                }

                console.log('added new user: "' + username + '"');

                // User id is:
                resolve(this.lastID);
            }
        );
    });
}

// Check that a username is available
async function checkAvail(username)
{
    // Insert the user into the database
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT id FROM users WHERE username == ?',
            [username],
            function (err, rows)
            {
                if (rows.length == 0)
                    resolve();
                else
                    reject('username not available "' + username + '"');
            }
        );
    });
}

// Lookup a user by username
async function lookupUser(username)
{
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT id, pwd_hash, pwd_salt, access FROM users WHERE username == ?;',
            [username],
            function (err, row)
            {
                // Check that the user exists
                if (err || !row)
                {
                    reject('user not found');
                }
                else
                {
                    resolve(row);
                }
            }
        );
    });
}

// Create a new session
async function createSession(userId, sessionId, loginTime, loginIP)
{
    return new Promise((resolve, reject) =>
    {
        // Serialize the commands
        db.serialize(() =>
        {
            // Delete previous sessions for this user id
            db.run(
                'DELETE FROM sessions WHERE user_id == ?;',
                [userId]
            );

            // Insert the new session into the table
            db.run(
                'INSERT INTO sessions ' +
                '(user_id, session_id, login_ip, login_time) ' +
                'VALUES (?, ?, ?, ?);',
                [userId, sessionId, loginIP, loginTime],
                function (err)
                {
                    if (err)
                        return reject('failed to create session');

                    resolve();
                }
            );
        })
    });
}

// Check that a session is valid
async function checkSession(userId, sessionId)
{
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT user_id FROM sessions WHERE user_id == ? AND session_id == ?',
            [userId, sessionId],
            function (err, row)
            {
                if (err || !row)
                {
                    return reject('invalid session');
                }

                resolve();
            }
        );
    });
}

// Get the access level for a given user
async function getAccess(userId)
{
    return new Promise((resolve, reject) =>
    {
        db.get(
            'SELECT access FROM users WHERE id == ?',
            [userId],
            function (err, row)
            {
                if (err || !row)
                {
                    reject('userId not found');
                    return;
                }

                resolve(row.access);
            }
        );
    });
}

// Check that a user has sufficient access
async function checkAccess(userId, sessionId, access)
{
    // Check that the session is valid
    await checkSession(userId, sessionId);

    // Get the access level for this userId
    let userAccess = await getAccess(userId);

    // Verify that the user has sufficient access
    switch (access)
    {
        case 'admin':
        return (userAccess == 'admin');

        default:
        throw TypeError('invalid access level:', access);
    }
}

// Get the title for a given projectId
async function getTitle(projectId)
{
    return new Promise((resolve, reject) =>
    {
        db.get(
            'SELECT title FROM projects WHERE id == ?',
            [projectId],
            function (err, row)
            {
                if (err || !row)
                {
                    reject('project not found');
                    return;
                }

                resolve(row.title);
            }
        );
    });
}

// Check for duplicate projects
async function checkDupes(crc32)
{
    return new Promise((resolve, reject) => {
        // Check for duplicate CRC32 hash
        db.all(
            'SELECT id FROM projects WHERE crc32 == ?;',
            [crc32],
            function (err, rows)
            {
                if (err)
                    return reject('duplicate check failed');

                // Prevent insertion of duplicates
                if (rows.length > 0)
                    return reject('duplicate project');

                resolve();
            }
        );
    });
}

// Insert the project into the database
async function insertProject(userId, title, data, crc32, submitTime, submitIP)
{
    return new Promise((resolve, reject) => {
        // Insert the project into the database
        db.run(
            'INSERT INTO projects ' +
            '(user_id, title, data, crc32, featured, submit_time, submit_ip) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?);',
            [userId, title, data, crc32, 0, submitTime, submitIP],
            function (err)
            {
                if (err)
                    return reject('failed to insert project');

                resolve(this.lastID);
            }
        );
    });
}

// Run a query that returns a single row with a value,
// and then extract the value
function getQueryValue(sqlQuery, vars)
{
    if (vars === undefined)
        vars = [];

    return new Promise((resolve, reject) =>
    {
        db.get(
            sqlQuery,
            vars,
            function (err, row)
            {
                if (err || !row)
                {
                    console.log(err);
                    reject('db query failed');
                    return;
                }

                let keys = Object.keys(row);

                if (keys.length > 1)
                {
                    reject('more than 1 output column');
                    return;
                }

                resolve(row[keys[0]]);
            }
        );
    });
}

//============================================================================

// Serve static file requests
app.use('/public', express.static('public'));

// Compile the index page EJS template
const indexTemplate = ejs.compile(
    fs.readFileSync(path.resolve('public/index.html'), 'utf8')
);

// Main (index) page
app.get('/', function(req, res)
{
    recordHit(req);

    let html = indexTemplate({ pageTitle: 'NoiseCraft'});
    res.setHeader('content-type', 'text/html');
    res.send(html);
});

// Serve projects with numerical ids
app.get('/:projectId([0-9]+)', async function(req, res)
{
    let projectId = parseInt(req.params.projectId);

    // The projectId must be a positive integer
    if (isNaN(projectId) || projectId < 1)
        return res.sendStatus(400);

    recordHit(req);

    // Set the title tag in the HTML data based on the project title
    // We do this so the project title can show up in webpage previews
    // e.g. links on social media
    let title = await getTitle(projectId)
        .catch(err =>{
            console.error(err);
        });

    let html = indexTemplate({ pageTitle: `${title} - NoiseCraft`});
    res.setHeader('content-type', 'text/html');
    res.send(html);
});

// Help page
app.get('/help', function(req, res)
{
    res.sendFile(path.resolve('public/help.html'));
});

// Browse page
app.get('/browse', function(req, res)
{
    res.sendFile(path.resolve('public/browse.html'));
});

// Compile the stats page EJS template
const statsTemplate = ejs.compile(
    fs.readFileSync(path.resolve('public/stats.html'), 'utf8')
);

app.get('/stats', async function (req, res)
{
    // Find the median value in a list of numbers
    function median(numList)
    {
        function compareFn(a, b)
        {
            if (a < b)
                return -1;
            else if (b > a)
                return 1;
            return 0;
        }

        let sortedNums = [...numList].sort(compareFn);
        return sortedNums[Math.floor(sortedNums.length/2)];
    }

    // Get the current timestamp
    let timeStamp = Date.now();

    // Get the timestamp at the last midnight in the local time zone
    let date = new Date();
    date.setHours(0);
    date.setMinutes(0);
    date.setSeconds(0);
    date.setMilliseconds(0);
    let lastMidnight = date.getTime()

    const DAY_IN_MS = 1000 * 3600 * 24;
    let NUM_DAYS = 40;
    let dayCounts = [];
    let dayStart = lastMidnight;

    console.log('seconds since midnight: ', (timeStamp - lastMidnight) / 1000);

    // For each day
    for (let i = 0; i < NUM_DAYS; ++i)
    {
        let dayEnd = dayStart + DAY_IN_MS;

        let dayCount = await getQueryValue(
            'SELECT COUNT(DISTINCT ip) FROM (SELECT * FROM hits WHERE time >= ? AND time <= ?)',
            [dayStart, dayEnd]
        )

        dayCounts.push(dayCount);

        // Move to the previous day
        dayStart -= DAY_IN_MS;
    }

    dayCounts.reverse();
    let daysExceptLast = dayCounts.slice(0, dayCounts.length - 1);
    let maxDayCount = Math.max(...dayCounts);
    let minDayCount = Math.min(...daysExceptLast);
    let medDayCount = median(dayCounts);
    let lastDayCount = dayCounts[dayCounts.length-1];
    dayCounts = dayCounts.map(count => count / maxDayCount);

    // Compute the number of unique hits in the last hour
    let uniqueHour = await getQueryValue(
        'SELECT COUNT(DISTINCT ip) FROM (SELECT * FROM hits WHERE time >= ?)',
        [timeStamp - 3600 * 1000]
    );

    // Compute the number of days since the first project was uploaded
    let minTime = await getQueryValue('SELECT MIN(time) from hits');
    let numDays = Math.floor((timeStamp - minTime) / (1000 * 3600 * 24));

    // Get various stats
    let totalHits = await getQueryValue('SELECT COUNT(*) FROM hits');
    let projectCount = await getQueryValue('SELECT COUNT(*) FROM projects');
    let userCount = await getQueryValue('SELECT COUNT(*) FROM users');
    let emailCount = await getQueryValue('SELECT COUNT(*) as count FROM (SELECT * FROM users WHERE email != "")');

    let html = statsTemplate({
        dayCounts: dayCounts,
        maxDayCount: maxDayCount,
        minDayCount: minDayCount,
        medDayCount: medDayCount,
        lastDayCount: lastDayCount,
        uniqueHour: uniqueHour,
        numDays: numDays,
        totalHits: totalHits,
        projectCount: projectCount,
        userCount: userCount,
        emailCount: emailCount,
    });

    res.setHeader('content-type', 'text/html');
    res.send(html);
});

/**
POST /register
Register a new user account
Arguments: username, password, email
*/
app.post('/register', jsonParser, async function (req, res)
{
    try
    {
        let username = req.body.username;
        let password = req.body.password;
        let email = req.body.email

        // Validate the username, password and email
        model.validateUserName(username);
        if (password.length > 64)
            return res.sendStatus(400);
        if (email.length > 64)
            return res.sendStatus(400);

        // Check that the username is available
        await checkAvail(username);

        // Add the new user to the database
        let submitIP = getClientIP(req);
        let userId = await addUser(username, password, email, submitIP);

        return res.send(JSON.stringify({
            userId: userId,
        }));
    }

    catch (e)
    {
        console.log('invalid register request');
        console.log(e);
        return res.sendStatus(400);
    }
})

/**
POST /login
Arguments: username, password
1. Lookup the user by username
2. Check that the password matches
3. Generate a session id and add it to the sessions table
4. Return the user id and session id
*/
app.post('/login', jsonParser, async function (req, res)
{
    try
    {
        var username = req.body.username;
        var password = req.body.password;

        // Lookup the user by username
        let {id, pwd_hash, pwd_salt, access} = await lookupUser(username);

        // Check the password
        if (cryptoHash(password + pwd_salt) != pwd_hash)
        {
            console.log('invalid password');
            return res.sendStatus(400);
        }

        // Generate a session id
        let sessionId = cryptoHash(String(Date.now()) + String(Math.random()));

        var loginTime = Date.now();
        var loginIP = getClientIP(req);

        await createSession(id, sessionId, loginTime, loginIP);

        console.log(`login from user "${username}" with access "${access}"`);

        return res.send(JSON.stringify({
            username: username,
            userId: id,
            sessionId: sessionId,
            access: access
        }));
    }

    catch (e)
    {
        console.log('invalid login request');
        console.log(e);
        return res.sendStatus(400);
    }
})

// POST /projects
app.post('/projects', jsonParser, async function (req, res)
{
    try
    {
        var userId = req.body.userId;
        var sessionId = req.body.sessionId;
        var title = req.body.title;
        var data = req.body.data;

        // Validate the title
        if (typeof title != 'string' || title.length == 0 || title.length > model.MAX_TITLE_LENGTH)
            return res.sendStatus(400);

        // Limit the length of the data, max 1MB
        if (data.length > 1_000_000)
            return res.sendStatus(400);

        // Check that the session is valid
        await checkSession(userId, sessionId);

        // Parse and validate the project data
        let project = JSON.parse(data);
        model.validateProject(project);

        // Do some extra validation on the project
        if (project.title != title)
            return res.sendStatus(400);
        if (Object.keys(project.nodes).length == 0)
            return res.sendStatus(400);

        // Reposition the nodes
        model.reposition(project);

        // Re-serialize the project data
        data = JSON.stringify(project);

        // Check for duplicate projects
        var crc32 = crc.crc32(data);
        await checkDupes(crc32);

        var submitTime = Date.now();
        var submitIP = getClientIP(req);

        // Insert the project in the database
        let projectId = await insertProject(
            userId,
            title,
            data,
            crc32,
            submitTime,
            submitIP
        );

        console.log(
            'submission successful, id: ' + projectId +
            ' (' + data.length + ' bytes)'
        );

        var resData = {
            projectId: projectId
        };

        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        return res.send(JSON.stringify(resData));
    }

    catch (e)
    {
        console.log('submit request failed');
        console.log(e);
        return res.sendStatus(400);
    }
})

// GET /list
// List shared projects
app.get('/list/:from', jsonParser, function (req, res)
{
    let fromIdx = req.params.from;
    let featured = !!req.query.featured;

    let sqlStr = (
        'SELECT projects.id, projects.title, projects.user_id, projects.submit_time, projects.featured, users.username FROM projects ' +
        'LEFT JOIN users ON projects.user_id = users.id ' +
        (featured? 'WHERE projects.featured == 1 ':'') +
        'ORDER BY submit_time DESC LIMIT ?,40;'
    );

    db.all(
        sqlStr,
        [fromIdx],
        function (err, rows)
        {
            if (err)
            {
                console.log(err);
                return res.sendStatus(400);
            }

            let jsonStr = JSON.stringify(rows);
            res.setHeader('Content-Type', 'application/json');
            res.send(jsonStr);
        }
    );
})

// POST /featured - set the featured flag for a project
app.post('/featured/:id', jsonParser, async function (req, res)
{
    let projectId = req.params.id;
    let userId = req.body.userId;
    let sessionId = req.body.sessionId;
    let featured = req.body.featured;

    // Check that the user has admin access
    await checkAccess(userId, sessionId, 'admin');

    if (isNaN(projectId) || projectId < 1)
        return res.sendStatus(400);

    featured = Boolean(featured)? 1:0;

    db.run(
        `UPDATE projects SET featured = ? WHERE id == ?;`,
        [featured, projectId],
        function (err, rows)
        {
            if (err)
            {
                console.log(err);
                return res.sendStatus(400);
            }

            res.setHeader('Content-Type', 'application/json');
            res.send(JSON.stringify(featured));
        }
    );
})

// GET /projects - returns project by ID
app.get('/projects/:id', function (req, res)
{
    let projectId = req.params.id;
    if (isNaN(projectId) || projectId < 1)
        return res.sendStatus(400);

    db.get(
        'SELECT user_id, title, data FROM projects WHERE id == ?;',
        [projectId],
        function (err, row)
        {
            if (err || !row)
                return res.sendStatus(404);

            res.setHeader('Content-Type', 'application/json');
            res.send(JSON.stringify(row));
        }
    );
})

// DELETE /projects
app.delete('/projects', async function (req, res)
{
    try
    {
        var projectId = req.params.id;
        var userId = req.body.userId;
        var sessionId = req.body.sessionId;

        // Check that the user has admin access
        await checkAccess(userId, sessionId, 'admin');

        console.log(`delete projectId=${projectId}`);

        db.run(
            'DELETE FROM projects WHERE id == ?;',
            [projectId]
        );

        return res.send('ok');
    }

    catch (e)
    {
        console.log('delete request failed');
        console.log(e);
        return res.sendStatus(400);
    }
})



app.post('/llm/prompt', jsonParser, async function (req, res)
{
    try
    {
        let prompt = req.body.prompt;
        if (typeof prompt != 'string' || prompt.length == 0 || prompt.length > 4000)
            return res.sendStatus(400);

        let llmRes = await promptOpenRouter([
            { role: 'system', content: buildNoiseCraftSystemPrompt() },
            {
                role: 'user',
                content: `Generate one complete NoiseCraft project from this request: ${prompt}

`
                    + 'Example output shape (fill with your own content): '
                    + '{"title":"Patch Name","nodes":{"0":{"type":"Sine","name":"Sine","x":0,"y":0,"ins":[null,null],"inNames":["freq","sync"],"outNames":["out"],"params":{"minVal":-1,"maxVal":1}}}}'
            },
        ], {
            model: req.body.model,
            maxTokens: req.body.maxTokens,
            temperature: req.body.temperature,
        });

        let project = await parseOrRepairGeneratedProject(llmRes.content, req.body.model);
        project = coerceGeneratedProject(project);
        autoConnectGeneratedProject(project);
        model.normalizeProject(project);
        model.validateProject(project);

        res.setHeader('Content-Type', 'application/json');
        return res.send(JSON.stringify({
            project: project,
            model: llmRes.model,
            usage: llmRes.usage,
        }));
    }
    catch (e)
    {
        console.log('llm prompt request failed');
        console.log(e);
        return res.sendStatus(400);
    }
});

//============================================================================

const server = app.listen(serverHTTPPortNo, () =>
{
    let address = server.address().address;
    let port = server.address().port;
    address = (address == "::")? "localhost":address;
    console.log(`app started at ${address}:${port}`);
});


const wss = new WebSocketServer({ server, path: '/ws-clock' });

wss.on('connection', (ws) =>
{
    ws.clockSessionId = null;
    ws.clockRole = 'client';

    ws.on('message', (data) =>
    {
        let msg = JSON.parse(data.toString());

        if (msg.type == 'JOIN_CLOCK_SESSION')
        {
            ws.clockSessionId = msg.sessionId || 'default';
            ws.clockRole = msg.role || 'client';
            let sess = getClockSession(ws.clockSessionId);
            sess.sockets.add(ws);
            if (ws.clockRole == 'host')
                sess.host = ws;
            return;
        }

        if (!ws.clockSessionId)
            return;

        let sess = getClockSession(ws.clockSessionId);

        // Only host can publish clock events
        if (sess.host !== ws)
            return;

        if (msg.type == 'CLOCK_PULSE' || msg.type == 'CLOCK_START' || msg.type == 'CLOCK_STOP')
        {
            for (let peer of sess.sockets)
            {
                if (peer !== ws && peer.readyState == peer.OPEN)
                    peer.send(JSON.stringify(msg));
            }
        }
    });

    ws.on('close', () =>
    {
        if (!ws.clockSessionId)
            return;

        let sess = getClockSession(ws.clockSessionId);
        sess.sockets.delete(ws);
        if (sess.host === ws)
            sess.host = null;
        if (sess.sockets.size == 0)
            clockSessions.delete(ws.clockSessionId);
    });
});
