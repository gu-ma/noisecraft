export class NetSync
{
    constructor()
    {
        this.mode = localStorage.getItem('net_sync_mode') || 'off';
        this.sessionId = localStorage.getItem('net_sync_session') || 'default';
        this.ws = null;
        this.serverStartTime = 0;
        this.localStartTime = 0;
        this.pulseCount = 0;
        this.lastPulseLogTime = 0;
        this.lastPulseTime = 0;
        this.tempoBpm = 0;

        if (this.mode != 'off')
            this.connect();
    }

    connect()
    {
        if (this.mode == 'off')
            return;

        if (this.ws)
        {
            if (this.ws.readyState == WebSocket.OPEN || this.ws.readyState == WebSocket.CONNECTING)
                return;
            this.ws = null;
        }

        let proto = (location.protocol === 'https:')? 'wss':'ws';
        this.ws = new WebSocket(`${proto}://${location.host}/ws-clock`);

        this.ws.onopen = () => {
            this.send({ type: 'JOIN_CLOCK_SESSION', sessionId: this.sessionId, role: this.mode });
            console.log(`[NetSync] connected mode=${this.mode} session=${this.sessionId}`);
        };

        this.ws.onerror = (err) => {
            console.log('[NetSync] websocket error', err);
        };

        this.ws.onclose = () => {
            this.ws = null;
        };

        this.ws.onmessage = (event) => {
            let msg = JSON.parse(event.data);
            this.logMessage('recv', msg);
            if (msg.type == 'CLOCK_START' && this.mode == 'client')
            {
                this.serverStartTime = msg.serverTime;
                this.localStartTime = performance.now();
                this.emit('NETSYNC_CLOCK_START', msg);
            }
            if (msg.type == 'CLOCK_STOP' && this.mode == 'client')
            {
                this.serverStartTime = 0;
                this.localStartTime = 0;
                this.pulseCount = 0;
                this.lastPulseLogTime = 0;
                this.lastPulseTime = 0;
                this.tempoBpm = 0;
                this.emit('NETSYNC_CLOCK_STOP', msg);
            }
            if (msg.type == 'CLOCK_PULSE' && this.mode == 'client')
            {
                let now = performance.now();
                if (this.lastPulseTime)
                {
                    let pulseMs = now - this.lastPulseTime;
                    let bpm = 60000 / (pulseMs * 24);
                    if (isFinite(bpm) && bpm > 20 && bpm < 400)
                    {
                        // Smooth tempo estimate to reduce jitter
                        this.tempoBpm = this.tempoBpm? (this.tempoBpm * 0.9 + bpm * 0.1):bpm;
                        this.emit('NETSYNC_TEMPO', { bpm: this.tempoBpm });
                    }
                }
                this.lastPulseTime = now;
                this.emit('NETSYNC_CLOCK_PULSE', msg);
            }
        };
    }


    emit(type, payload={})
    {
        window.dispatchEvent(new CustomEvent(type, { detail: payload }));
    }

    logMessage(direction, msg)
    {
        if (msg.type == 'CLOCK_PULSE')
        {
            this.pulseCount += 1;
            if ((this.pulseCount % 24) != 0)
                return;

            let now = performance.now();
            let dt = this.lastPulseLogTime? (now - this.lastPulseLogTime):0;
            this.lastPulseLogTime = now;
            console.log(`[NetSync] ${direction} CLOCK_PULSE x24 session=${this.sessionId} dt=${dt.toFixed(1)}ms`);
            return;
        }

        console.log(`[NetSync] ${direction} ${msg.type} session=${this.sessionId}`);
    }

    configure(mode, sessionId)
    {
        let nextMode = mode || 'off';
        let nextSessionId = sessionId || 'default';
        let modeChanged = (this.mode != nextMode);
        let sessionChanged = (this.sessionId != nextSessionId);

        this.mode = nextMode;
        this.sessionId = nextSessionId;
        localStorage.setItem('net_sync_mode', nextMode);
        localStorage.setItem('net_sync_session', nextSessionId);

        if (!modeChanged && !sessionChanged)
            return;

        if (nextMode == 'off')
        {
            if (this.ws)
                this.ws.close();
            this.ws = null;
            return;
        }

        if (this.ws)
        {
            this.ws.close();
            this.ws = null;
        }

        this.connect();
    }

    send(msg)
    {
        if (!this.ws || this.ws.readyState != WebSocket.OPEN)
            return;
        this.ws.send(JSON.stringify(msg));
        this.logMessage('send', msg);
    }

    sendPulse(pulseTime)
    {
        if (this.mode != 'host')
            return;
        this.send({ type: 'CLOCK_PULSE', sessionId: this.sessionId, time: pulseTime });
    }

    sendStart()
    {
        if (this.mode != 'host')
            return;
        this.send({ type: 'CLOCK_START', sessionId: this.sessionId, serverTime: Date.now() });
    }

    sendStop()
    {
        if (this.mode != 'host')
            return;
        this.send({ type: 'CLOCK_STOP', sessionId: this.sessionId, serverTime: Date.now() });
    }
}

export const netSync = new NetSync();
