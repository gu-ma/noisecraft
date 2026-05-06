export class NetSync
{
    constructor()
    {
        this.mode = localStorage.getItem('net_sync_mode') || 'off';
        this.sessionId = localStorage.getItem('net_sync_session') || 'default';
        this.ws = null;
        this.serverStartTime = 0;
        this.localStartTime = 0;

        if (this.mode != 'off')
            this.connect();
    }

    connect()
    {
        if (this.ws)
            this.ws.close();

        let proto = (location.protocol === 'https:')? 'wss':'ws';
        this.ws = new WebSocket(`${proto}://${location.host}/ws-clock`);

        this.ws.onopen = () => {
            this.send({ type: 'JOIN_CLOCK_SESSION', sessionId: this.sessionId, role: this.mode });
            console.log(`[NetSync] connected mode=${this.mode} session=${this.sessionId}`);
        };

        this.ws.onmessage = (event) => {
            let msg = JSON.parse(event.data);
            if (msg.type == 'CLOCK_START' && this.mode == 'client')
            {
                this.serverStartTime = msg.serverTime;
                this.localStartTime = performance.now();
            }
            if (msg.type == 'CLOCK_STOP' && this.mode == 'client')
            {
                this.serverStartTime = 0;
                this.localStartTime = 0;
            }
        };
    }

    configure(mode, sessionId)
    {
        this.mode = mode;
        this.sessionId = sessionId;
        localStorage.setItem('net_sync_mode', mode);
        localStorage.setItem('net_sync_session', sessionId);
        if (mode == 'off')
        {
            if (this.ws)
                this.ws.close();
            this.ws = null;
            return;
        }
        this.connect();
    }

    send(msg)
    {
        if (!this.ws || this.ws.readyState != WebSocket.OPEN)
            return;
        this.ws.send(JSON.stringify(msg));
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
