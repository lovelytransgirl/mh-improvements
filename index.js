const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const expressWs = require('express-ws');
const WebSocket = require('ws');
const cors = require('cors');
const fs = require('fs');
// config
const config = require('./config');

// oHttp
const oHttp = {
    connection: function() {
        return {
            request: {
                url: null,
                type: null,
                body: null,
                headers: null
            },
            response: {
                code: null,
                status: null,
                body: null,
                connection: null
            }
        };
    },

    async makeRequest(url, type, body = null, headers) {
        const conn = this.connection();
        conn.request.url = url;
        conn.request.type = type;
        conn.request.body = body;
        conn.request.headers = headers;

        try {
            const options = {
                method: type,
                credentials: 'include'
            };

            if (body) {
                options.body = body;
            }

            if (headers) {
                options.headers = headers;
            }

            const response = await fetch(url, options);
            const rawResponse = response.clone();

            let responseData;
            const jsonResponse = response.clone();
            
            try {
                responseData = await jsonResponse.json();
            } catch (error) {
                responseData = await response.text();
            }

            conn.response.code = response.status;
            conn.response.status = response.status;
            conn.response.body = responseData;
            conn.response.raw = rawResponse;
            conn.response.connection = response;

            return conn;
        } catch (error) {
            throw {
                error: error,
                message: error.message,
                conn: error.conn
            };
        }
    },

    get: function(url, headers = null) {
        return this.makeRequest(url, 'GET', null, headers);
    },

    post: function(url, body, headers = null) {
        return this.makeRequest(url, 'POST', body, headers);
    },

    put: function(url, body, headers = null) {
        return this.makeRequest(url, 'PUT', body, headers);
    },

    patch: function(url, body, headers = null) {
        return this.makeRequest(url, 'PATCH', body, headers);
    },

    delete: function(url, headers = null) {
        return this.makeRequest(url, 'DELETE', null, headers);
    },

    options: function(url, headers = null) {
        return this.makeRequest(url, 'OPTIONS', null, headers);
    },

    other: function(url, type, body, headers = null) {
        return this.makeRequest(url, type, body, headers);
    }
}

const app = express();
// if port is not set, use 8081 and log it
if (!config.port) {
    console.log('Port is not properly set in config.js, using the default port 8081.');
    config.port = 8081;
}
const port = config.port;

// Middleware & CORS
app.use(express.raw({type: '*/*', limit: '11mb', extended: true}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(
    cors({
      origin: (origin, callback) => {
        callback(null, origin); // Reflect the incoming origin
      },
      credentials: true, // Allow cookies and credentials from other origins (so you can make your own panel frontend)
    })
  );
expressWs(app);

// Helper function to check auth
const checkAuth = (req, res, next) => {
    if (!req.cookies.minehut_id || !req.cookies.token || 
        !req.cookies.sessionId || !req.cookies.profile_id) {
        // return an html page in /views/login.ejs
        return res.render('login', {
            req: req
        });
    }
    next();
};

// Serve the main page
app.get('/', checkAuth, async (req, res) => {    
    res.render('base', { 
        page: 'server-list',
        req: req
    });
});

// assets endpoint
app.get('/assets/:file', (req, res) => {
    // check if file exists
    if (!fs.existsSync(path.join(__dirname, '/views/assets', req.params.file))) {
        return res.status(404).send('Looks like you are trying to access a file that does not exist. Are you lost?');
    } else {
        // if param tries to use bash, return 403
        if (req.params.file.includes('..')) {
            return res.status(403).send('Are you trying to access a file outside of the assets folder?');
        } else {
            // check if file is a directory
            if (fs.statSync(path.join(__dirname, '/views/assets', req.params.file)).isDirectory()) {
                return res.status(403).send('Are you trying to access a directory?');
            } else {
                res.sendFile(path.join(__dirname, '/views/assets', req.params.file));
            }
        }
    }
});

// public servers endpoint
app.get('/servers', async (req, res) => {    
    res.render('base', { 
        page: 'servers',
        req: req
    });
});

// API endpoint to fetch all data from Minehut
app.get('/getData', async (req, res) => {
    const minehutId = req.cookies.minehut_id;
    const token = req.cookies.token;
    const sessionId = req.cookies.sessionId;
    const profileId = req.cookies.profile_id;

    if (!minehutId || !token || !sessionId || !profileId) {
        return res.status(400).send({ expired: true, message: "Session expired. Please login." });
    }

    try {
        const conn = await oHttp.get(`https://api.dev.minehut.com/servers/${minehutId}/all_data`,
            {
                Authorization: `Bearer ${token}`,
                'accept-language': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'x-profile-id': profileId,  // Corrected to use profileId
                'x-session-id': sessionId
            }
        );

        res.json(conn.response.body);
    } catch (error) {
        console.log(error);
        if (error.conn && error.conn.response && error.conn.response.body && error.conn.response.body.expired) {
            // Clear cookies and respond to the frontend
            res.clearCookie('minehut_id');
            res.clearCookie('token');
            res.clearCookie('sessionId');
            res.clearCookie('profile_id');
            res.status(401).send({ expired: true, message: "Session expired. Please login." });
        } else {
            res.status(500).send('Error fetching data from Minehut API.');
        }
    }
});

// Endpoint to handle session token and redirect
app.get('/auth/session/:token', async (req, res) => {
    const token = req.params.token;

    try {
        // Make request to the external Minehut API to get session data
        const conn = await oHttp.get(`https://api.dev.minehut.com/auth/session/${token}`);
        const response = conn.response;

        const sessionData = response.body;

        // Extract necessary fields and store them in cookies
        const minehutId = sessionData.minehut_id;
        const sessionId = sessionData.sessionId;
        const tokenValue = sessionData.token.value;
        const profileId = sessionData.id;  // Corrected to use id for profile_id

        res.cookie('minehut_id', minehutId, { httpOnly: false, maxAge: 1000 * 60 * 60 * 24 }); // 1 day expiry
        res.cookie('token', tokenValue, { httpOnly: false, maxAge: 1000 * 60 * 60 * 24 }); // 1 day expiry
        res.cookie('sessionId', sessionId, { httpOnly: false, maxAge: 1000 * 60 * 60 * 24 }); // 1 day expiry
        res.cookie('profile_id', profileId, { httpOnly: false, maxAge: 1000 * 60 * 60 * 24 }); // 1 day expiry

        // Redirect to the main page after saving cookies
        res.redirect('/');
    } catch (error) {
        console.error('Error during authentication:', error);
        res.status(500).send('Failed to authenticate. Please try again.');
    }
});

app.ws('/proxy/server/:id/console', function (ws, req) {
    const minehutId = req.cookies.minehut_id;
    const token = req.cookies.token;
    const profileId = req.cookies.profile_id;
    const sessionId = req.cookies.sessionId;

    if (!minehutId || !token || !sessionId || !profileId) {
        return res.status(400).send({ expired: true, message: "Session expired. Please login." });
    }

    const clientWs = new WebSocket(`https://${req.params.id}.manager.dev.minehut.com/socket`, [
        token,
        sessionId,
        profileId
    ]);

    let messageQueue = []; // Queue to store messages until WebSocket is open
    let isClientWsOpen = false;

    // When clientWs opens, send all queued messages
    clientWs.on('open', () => {
        isClientWsOpen = true;

        // Send all queued messages
        while (messageQueue.length > 0) {
            const message = messageQueue.shift();
            clientWs.send(message);
        }
    });

    // Forward messages from clientWs to ws
    clientWs.on('message', (data) => ws.send(data));

    // Handle messages from ws to clientWs
    ws.on('message', (data) => {
        if (isClientWsOpen) {
            clientWs.send(data);
        } else {
            messageQueue.push(data);
        }
    });

    // Close connections on either side
    ws.on('close', () => {
        clientWs.close();
    });
    clientWs.on('close', () => {
        ws.close();
    });

    // Handle WebSocket errors
    clientWs.on('error', (err) => {
        ws.close();
        clientWs.close();
    });
    ws.on('error', (err) => {
        clientWs.send('{"Error": "' + JSON.stringify(err) + '"');
        clientWs.close();
        ws.close();
    });
});

function processHeaders(req) {
    const priorityHeader = req.headers['accept-language'];
    let headersToForward = {};

    if (priorityHeader && priorityHeader.includes(':|:|:')) {
        const headersToInclude = priorityHeader.split(':|:|:')
            .filter(Boolean)
            .map(header => {
                const [key, value] = header.split(',').map(part => part.replace(/[{}"]/g, '').trim());
                return { key, value };
            });
            
        headersToInclude.forEach(({ key, value }) => {
            if (value !== null && value !== undefined) {
                headersToForward[key] = value;
            }
        });
    }
    
    return headersToForward;
}

app.use('/proxy/*', async (req, res) => {
    const minehutId = req.cookies.minehut_id;
    const token = req.cookies.token;
    const sessionId = req.cookies.sessionId;
    const profileId = req.cookies.profile_id;
    
    if (!minehutId || !token || !sessionId || !profileId) {
        return res.status(401).send('Session expired. Please log in.');
    }

    let headersToForward = processHeaders(req);

    let requestBody = req.body;
    if (Buffer.isBuffer(requestBody)) {
        requestBody = requestBody.toString();
    }

    if (req.is('json') && requestBody) {
        try {
            requestBody = JSON.stringify(JSON.parse(requestBody));
        } catch (e) {
            return res.status(400).json({ error: 'Invalid JSON in request body', details: e.message });
        }
    }
    
    try {
        // logging the send request
        const conn = await oHttp.other(
            `https://api.dev.minehut.com${req.originalUrl.replace('/proxy', '')}`,
            req.method,
            req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' ? requestBody : null,
            {
                ...headersToForward,
                'content-type': req.headers['content-type'] || 'application/json',
                Authorization: `Bearer ${token}`,
                'x-profile-id': profileId,
                'x-session-id': sessionId 
            }
        );

        const response = conn.response;
        
        res.status(response.status).send(response.body);
    } catch (error) {
        console.log(error);
        if (error.conn) {
            if (error.conn?.response?.data?.expired) {
                res.clearCookie('minehut_id');
                res.clearCookie('token');
                res.clearCookie('sessionId');
                res.clearCookie('profile_id');
                return res.status(401).json({ error: 'Session expired. Please log in again.' });
            }
            return res.status(error.conn.response.status ? error.conn.response.status : 400 ).json(error.conn.response.body);
        }
        return res.status(500).json({ error: error.message || 'An unknown error occurred' });
    }
});

app.use('/manager/:id*', async (req, res) => {
    const minehutId = req.cookies.minehut_id;
    const token = req.cookies.token;
    const sessionId = req.cookies.sessionId;
    const profileId = req.cookies.profile_id;
    
    if (!minehutId || !token || !sessionId || !profileId) {
        return res.status(401).send('Session expired. Please log in.');
    }

    let headersToForward = processHeaders(req);

    let requestBody = req.body;
    if (Buffer.isBuffer(requestBody)) {
        requestBody = requestBody.toString();
    }

    if (req.is('json') && requestBody) {
        try {
            requestBody = JSON.stringify(JSON.parse(requestBody));
        } catch (e) {
            return res.status(400).json({ error: 'Invalid JSON in request body', details: e.message });
        }
    }
    
    try {
        const conn = await oHttp.other(
            `https://${req.params.id}.manager.dev.minehut.com${req.originalUrl.replace(`/manager/${req.params.id}`, '')}`,
            req.method,
            req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' ? requestBody : null,
            {
                ...headersToForward,
                'content-type': req.headers['content-type'] || 'application/json',
                Authorization: `Bearer ${token}`,
                'x-profile-id': profileId,
                'x-session-id': sessionId 
            }
        );
        const response = conn.response;

        return res.status(response.status).json(response.body);
    } catch (error) {
        console.log(error);
        if (error.conn) {
            if (error.conn?.response?.data?.expired) {
                res.clearCookie('minehut_id');
                res.clearCookie('token');
                res.clearCookie('sessionId');
                res.clearCookie('profile_id');
                return res.status(401).json({ error: 'Session expired. Please log in again.' });
            }
            return res.status(error.conn.response.status ? error.conn.response.status : 400 ).json(error.conn.response.body);
        }
        return res.status(500).json({ error: error.message || 'An unknown error occurred' });
    }
});

// Routes
app.get('/server/:id', checkAuth, (req, res) => {
    res.redirect(`/server/${req.params.id}/console`);
});

app.get('/server/:id/console', checkAuth, (req, res) => {
    res.render('base', { 
        page: 'console',
        req: req,
        serverId: req.params.id
    });
});

app.get('/server/:id/settings', checkAuth, (req, res) => {
    res.render('base', { 
        page: 'settings',
        req: req,
        serverId: req.params.id
    });
});

app.get('/server/:id/stats', checkAuth, (req, res) => {
    res.render('base', { 
        page: 'stats',
        req: req,
        serverId: req.params.id
    });
});

app.get('/server/:id/files', checkAuth, (req, res) => {
    res.render('base', { 
        page: 'file',
        req: req,
        serverId: req.params.id
    });
});

app.get('/user', checkAuth, (req, res) => {
    res.render('base', { 
        page: 'user',
        req: req
    });
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});

