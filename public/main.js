import { anyInputActive } from './utils.js';
import { Dialog, errorDialog } from './dialog.js';
import { Model, Paste, Play, Stop, SetParam } from './model.js';
import { Editor } from './editor.js';
import { AudioView } from './audioview.js';
import { TitleView } from './titleview.js';
import * as session from './session.js';
import * as sharing from './sharing.js';
import { netSync } from './netsync.js';

// Project title input
let inputProjectTitle = document.getElementById('project_title');

// Menu buttons
let btnOpen = document.getElementById('btn_open');
let btnLoadURL = document.getElementById('btn_load_url');
let btnSave = document.getElementById('btn_save');
let btnShare = document.getElementById('btn_share');
let btnGenerate = document.getElementById('btn_generate');
let btnPlay = document.getElementById('btn_play');
let btnStop = document.getElementById('btn_stop');
let netSyncBadge = document.getElementById('net_sync_badge');

// Project model/state
let model = new Model();

// Graph editor view
let editor = new Editor(model);

// Audio view of the model
let audioView = new AudioView(model);

// View that updates the webpage title
let titleView = new TitleView(model);

// Most recent location of a mouse or touch event
let cursor = { x: 0, y: 0 };


function updateNetSyncBadge()
{
    let mode = netSync.mode || 'off';
    let state = 'disconnected';

    if (mode != 'off' && netSync.ws)
    {
        if (netSync.ws.readyState == WebSocket.OPEN)
            state = 'connected';
        else if (netSync.ws.readyState == WebSocket.CONNECTING)
            state = 'connecting';
    }

    netSyncBadge.className = `status_badge status_badge_${mode}`;
    netSyncBadge.textContent = `NetSync: ${mode} (${state})`;
}

document.body.onload = async function ()
{
    //browserWarning();

    // Optional network clock sync config via URL params:
    // ?net_sync=off|host|client&net_session=my-room
    const params = new URLSearchParams(location.search);
    const syncMode = params.get('net_sync');
    const syncSession = params.get('net_session');
    updateNetSyncBadge();
    setInterval(updateNetSyncBadge, 1000);


    window.addEventListener('NETSYNC_CLOCK_START', () => {
        if (netSync.mode == 'client')
            startPlayback();
    });

    window.addEventListener('NETSYNC_CLOCK_STOP', () => {
        if (netSync.mode == 'client')
            stopPlayback();
    });


    window.addEventListener('NETSYNC_TEMPO', (evt) => {
        if (netSync.mode != 'client')
            return;

        let bpm = evt.detail.bpm;
        if (!isFinite(bpm))
            return;

        // Apply synced tempo to every Clock node in the patch
        let nodes = model.state.nodes;
        for (let nodeId in nodes)
        {
            let node = nodes[nodeId];
            if (node.type == 'Clock' && editor.nodes.has(nodeId))
                model.update(new SetParam(nodeId, 'value', bpm));
        }
    });

    if (syncMode)
    {
        if (syncMode == 'off' || syncMode == 'host' || syncMode == 'client')
        {
            netSync.configure(syncMode, syncSession || 'default');
        }
        else
        {
            console.warn(`[NetSync] ignoring invalid net_sync mode: ${syncMode}`);
        }
    }

    // Parse the projectId from the path
    let path = location.pathname;
    let projectId = parseInt(location.pathname.replace('/',''));

    // If a projectId was supplied
    if (!isNaN(projectId))
    {
        // Download the serialized project data
        let data = await sharing.getProject(projectId);

        // Try to import the project
        importModel(data);

        return;
    }

    // If a hash location was supplied
    if (location.hash)
    {
        if (location.hash == '#new')
        {
            model.new();

            // Avoid erasing saved state on refresh/reload
            history.replaceState(null, null, ' ');

            return;
        }

        // Note: projectIds encoded in the location hash are deprecated
        // but we will keep supporting them for a bit for backwards
        // compatibility with old URLs
        //
        // Download the serialized project data
        let projectId = location.hash.slice(1);
        let data = await sharing.getProject(projectId);

        // Try to import the project
        importModel(data);

        return;
    }

    let serializedModelData = localStorage.getItem('latestModelData');

    if (!serializedModelData)
    {
        model.new();
        return;
    }

    try
    {
        importModel(serializedModelData);
    }
    catch (e)
    {
        console.log(e.stack);

        // If loading failed, we don't want to reload
        // the same data again next time
        localStorage.removeItem('latestModelData');

        // Reset the project
        model.new();
    }
}

window.onunload = function ()
{
    // Save the graph when unloading the page
    localStorage.setItem('latestModelData', model.serialize());
}

window.onmousedown = handleMouseEvent;
window.onmousemove = handleMouseEvent;

window.onkeydown = function (event)
{
    // If a text input box is active, do nothing
    if (anyInputActive())
        return;

    // Spacebar triggers play/stop
    if (event.code == 'Space')
    {
        if (model.playing)
        {
            stopPlayback();
        }
        else
        {
            startPlayback();
        }

        event.preventDefault();
    }

    // Ctrl or Command key
    if (event.ctrlKey || event.metaKey)
    {
        // Ctrl + S (save)
        if (event.code == 'KeyS')
        {
            saveModelFile();
            event.preventDefault();
        }

        // Ctrl + Z (undo)
        if (event.code == 'KeyZ')
        {
            console.log('undo');
            event.preventDefault();
            model.undo();
        }

        // Ctrl + Y (redo)
        if (event.code == 'KeyY')
        {
            console.log('redo');
            event.preventDefault();
            model.redo();
        }

        // Ctrl + A (select all)
        if (event.code == 'KeyA')
        {
            event.preventDefault();
            editor.selectAll();
        }

        // Ctrl + G (group nodes)
        if (event.code == 'KeyG' && location.hostname == 'localhost')
        {
            console.log('group nodes');
            event.preventDefault();
            editor.groupSelected();
        }

        return;
    }

    // Delete or backspace key
    if (event.code == 'Backspace' || event.code == 'Delete')
    {
        console.log('delete key');
        event.preventDefault();
        editor.deleteSelected();
        return;
    }
}

document.oncopy = function (evt)
{
    if (anyInputActive())
        return;

    if (!editor.selected.length)
        return;

    let data = JSON.stringify(model.copy(editor.selected));
    evt.clipboardData.setData('text/plain', data);
    evt.preventDefault();
}

document.oncut = function (evt)
{
    if (anyInputActive())
        return;

    if (!editor.selected.length)
        return;

    let data = JSON.stringify(model.copy(editor.selected));
    evt.clipboardData.setData('text/plain', data);
    evt.preventDefault();

    editor.deleteSelected();
}

document.onpaste = function (evt)
{
    if (anyInputActive())
        return;

    try
    {
        let clipData = evt.clipboardData.getData('text/plain');
        let nodeData = JSON.parse(clipData)
        model.update(new Paste(nodeData, cursor.x, cursor.y));
        evt.preventDefault();
    }

    catch (e)
    {
        console.log(e);
    }
}


async function requestAIGeneration(prompt, options = {})
{
    let response = await fetch('/llm/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            prompt,
            examples: options.examples || [],
            remoteExamples: options.remoteExamples || [],
            remixMode: options.remixMode || 'balanced',
            model: options.model || '',
        }),
    });

    if (!response.ok)
    {
        let errMsg = 'AI generation failed';

        try
        {
            let errData = await response.json();
            if (typeof errData?.error == 'string')
                errMsg = errData.error + (errData.requestId? ` (requestId=${errData.requestId})`:'');
        }
        catch (e)
        {
        }

        throw TypeError(errMsg);
    }

    return response.json();
}



async function requestAIGenerationStream(prompt, handlers = {}, options = {})
{
    let response = await fetch('/llm/prompt/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            prompt,
            examples: options.examples || [],
            remoteExamples: options.remoteExamples || [],
            remixMode: options.remixMode || 'balanced',
            model: options.model || '',
        }),
    });

    if (!response.ok || !response.body)
        throw TypeError('AI stream request failed');

    let reader = response.body.getReader();
    let decoder = new TextDecoder();
    let buffer = '';

    while (true)
    {
        let { done, value } = await reader.read();
        if (done)
            break;

        buffer += decoder.decode(value, { stream: true });

        while (true)
        {
            let splitIdx = buffer.indexOf('\n\n');
            if (splitIdx == -1)
                break;

            let rawEvent = buffer.slice(0, splitIdx);
            buffer = buffer.slice(splitIdx + 2);

            let evType = 'message';
            let evData = '';

            for (let line of rawEvent.split('\n'))
            {
                if (line.startsWith('event:'))
                    evType = line.slice(6).trim();
                if (line.startsWith('data:'))
                    evData += line.slice(5).trim();
            }

            let payload = {};
            if (evData)
                payload = JSON.parse(evData);

            if (evType == 'token' && handlers.onToken)
                handlers.onToken(payload);
            if (evType == 'reasoning' && handlers.onReasoning)
                handlers.onReasoning(payload);
            if (evType == 'status' && handlers.onStatus)
                handlers.onStatus(payload);
            if (evType == 'result' && handlers.onResult)
                handlers.onResult(payload);
            if (evType == 'error' && handlers.onError)
                handlers.onError(payload);
        }
    }
}

function showGenerateDialog()
{
    let dialog = new Dialog('Generate with AI');
    let promptIdeas = [
        'A bass that moves like a shadow under the floorboards.',
        'A lead synth that cuts through the night like neon glass.',
        'A soft pad drifting over a cold lake at dawn.',
        'A tiny chiptune voice from a forgotten handheld console.',
        'A deep sub tone felt more than heard.',
        'A warm sequencer circling like a small constellation.',
        'A wandering generative melody with no destination.',
        'A sequencer that sounds like machinery learning to dance.',
        'A minimal techno pulse, dry and focused.',
        'A self-playing bassline with a hypnotic heartbeat.',
        'A hi-hat made from silver static.',
        'A snare like paper tearing in a tunnel.',
        'A kick drum from a deep underground room.',
        'A metallic percussion voice struck in the dark.',
        'A spacious delay instrument that leaves trails behind itself.',
        'A square wave lead with toy-like confidence.',
    ];

    let promptLabel = document.createElement('p');
    promptLabel.textContent = 'Describe the instrument/patch you want to generate:';
    dialog.appendChild(promptLabel);

    let textArea = document.createElement('textarea');
    textArea.rows = 5;
    textArea.style.width = '95%';
    textArea.placeholder = 'Example: warm analog bass with subtle filter movement';
    dialog.appendChild(textArea);

    let ideasLabel = document.createElement('p');
    ideasLabel.textContent = 'Prompt inspiration (optional):';
    dialog.appendChild(ideasLabel);

    let ideasSelect = document.createElement('select');
    ideasSelect.style.width = '95%';
    let ideasDefaultOpt = document.createElement('option');
    ideasDefaultOpt.value = '';
    ideasDefaultOpt.textContent = '-- Choose an inspiration prompt --';
    ideasSelect.appendChild(ideasDefaultOpt);
    for (let idea of promptIdeas)
    {
        let option = document.createElement('option');
        option.value = idea;
        option.textContent = idea;
        ideasSelect.appendChild(option);
    }
    ideasSelect.onchange = () =>
    {
        if (ideasSelect.value)
            textArea.value = ideasSelect.value;
    };
    dialog.appendChild(ideasSelect);

    let exampleLabel = document.createElement('p');
    exampleLabel.textContent = 'Reference examples (optional, max 4):';
    dialog.appendChild(exampleLabel);

    let exampleSelect = document.createElement('select');
    exampleSelect.multiple = true;
    exampleSelect.size = 8;
    exampleSelect.style.width = '95%';
    dialog.appendChild(exampleSelect);

    let remoteExamplesLabel = document.createElement('p');
    remoteExamplesLabel.textContent = 'Remote remix refs (optional, one URL/ID per line, max combined examples: 4):';
    dialog.appendChild(remoteExamplesLabel);

    let remoteExamplesArea = document.createElement('textarea');
    remoteExamplesArea.rows = 3;
    remoteExamplesArea.style.width = '95%';
    remoteExamplesArea.placeholder = 'https://noisecraft.app/162\n275';
    dialog.appendChild(remoteExamplesArea);

    let remixModeLabel = document.createElement('p');
    remixModeLabel.textContent = 'Remix mode:';
    dialog.appendChild(remixModeLabel);

    let remixModeSelect = document.createElement('select');
    remixModeSelect.style.width = '95%';
    for (let mode of ['balanced', 'strict', 'loose'])
    {
        let option = document.createElement('option');
        option.value = mode;
        option.textContent = mode;
        if (mode == 'balanced')
            option.selected = true;
        remixModeSelect.appendChild(option);
    }
    dialog.appendChild(remixModeSelect);

    let modelLabel = document.createElement('p');
    modelLabel.textContent = 'Model:';
    dialog.appendChild(modelLabel);

    let modelSelect = document.createElement('select');
    modelSelect.style.width = '95%';
    for (let modelName of [
        'google/gemini-3.1-flash-lite',
        'moonshotai/kimi-k2.6',
        'qwen/qwen3.6-35b-a3b',
        'qwen/qwen3.6-27b',
        'qwen/qwen3.6-flash',
        'openai/gpt-5.3-codex',
        'openai/gpt-5.4',
        'openai/gpt-5.4-mini',
    ])
    {
        let option = document.createElement('option');
        option.value = modelName;
        option.textContent = modelName;
        if (modelName == 'google/gemini-3.1-flash-lite')
            option.selected = true;
        modelSelect.appendChild(option);
    }
    dialog.appendChild(modelSelect);

    let previewPre = document.createElement('pre');
    previewPre.style.whiteSpace = 'pre-wrap';
    previewPre.style.maxHeight = '180px';
    previewPre.style.overflowY = 'auto';
    previewPre.style.fontSize = '12px';
    previewPre.textContent = 'Click Generate to start streaming output.';
    dialog.appendChild(previewPre);

    let statusP = document.createElement('p');
    statusP.textContent = 'Status: idle';
    dialog.appendChild(statusP);

    let reasoningPre = document.createElement('pre');
    reasoningPre.style.whiteSpace = 'pre-wrap';
    reasoningPre.style.maxHeight = '120px';
    reasoningPre.style.overflowY = 'auto';
    reasoningPre.style.fontSize = '11px';
    reasoningPre.textContent = '';
    dialog.appendChild(reasoningPre);

    let generateBtn = document.createElement('button');
    generateBtn.className = 'form_btn';
    generateBtn.textContent = 'Generate';

    let regenBtn = document.createElement('button');
    regenBtn.className = 'form_btn';
    regenBtn.textContent = 'Regenerate';
    regenBtn.style.marginLeft = '8px';

    let useBtn = document.createElement('button');
    useBtn.className = 'form_btn';
    useBtn.textContent = 'Use';
    useBtn.style.marginLeft = '8px';
    useBtn.disabled = true;

    let closeBtn = document.createElement('button');
    closeBtn.className = 'form_btn';
    closeBtn.textContent = 'Close';
    closeBtn.style.marginLeft = '8px';

    let generatedProject = null;
    let exampleNames = [];

    fetch('/llm/examples')
        .then(response => response.json())
        .then(data =>
        {
            exampleNames = data.examples || [];
            for (let fileName of exampleNames)
            {
                let option = document.createElement('option');
                option.value = fileName;
                option.textContent = fileName;
                exampleSelect.appendChild(option);
            }
        })
        .catch((e) => console.log(e));

    async function runGeneration()
    {
        try
        {
            dialog.hideError();
            let prompt = textArea.value.trim();
            if (!prompt)
            {
                dialog.showError('Please enter a prompt.');
                return;
            }

            generatedProject = null;
            useBtn.disabled = true;
            previewPre.textContent = '';
            reasoningPre.textContent = '';
            statusP.textContent = 'Status: generating...';
            let selectedExamples = [...exampleSelect.selectedOptions].map(opt => opt.value).slice(0, 4);
            let remoteExamples = remoteExamplesArea.value
                .split('\n')
                .map(v => v.trim())
                .filter(Boolean);
            let remixMode = remixModeSelect.value || 'balanced';
            let selectedModel = modelSelect.value || 'google/gemini-3.1-flash-lite';

            await requestAIGenerationStream(prompt, {
                onToken: (msg) =>
                {
                    previewPre.textContent += msg.text || '';
                    previewPre.scrollTop = previewPre.scrollHeight;
                },
                onReasoning: (msg) =>
                {
                    reasoningPre.textContent += msg.text || '';
                    reasoningPre.scrollTop = reasoningPre.scrollHeight;
                    statusP.textContent = `Status: reasoning (${reasoningPre.textContent.length} chars)`;
                },
                onStatus: (msg) =>
                {
                    statusP.textContent = `Status: ${msg.stage || 'working'}`;
                },
                onResult: (msg) =>
                {
                    generatedProject = msg.project;
                    previewPre.textContent = JSON.stringify(generatedProject, null, 2);
                    statusP.textContent = `Status: done (${msg.elapsedMs || 0}ms)`;
                    useBtn.disabled = false;
                },
                onError: (msg) =>
                {
                    statusP.textContent = 'Status: error';
                    throw TypeError((msg.error || 'Generation failed') + (msg.requestId? ` (requestId=${msg.requestId})`:''));
                }
            }, {
                examples: selectedExamples,
                remoteExamples: remoteExamples,
                remixMode: remixMode,
                model: selectedModel,
            });
        }
        catch (e)
        {
            console.log(e);
            useBtn.disabled = true;
            statusP.textContent = 'Status: error';
            dialog.showError(e.message || 'Generation failed. Check server logs/API key.');
        }
    }

    generateBtn.onclick = runGeneration;
    regenBtn.onclick = runGeneration;

    useBtn.onclick = () =>
    {
        if (!generatedProject)
            return;

        importModel(JSON.stringify(generatedProject));
        dialog.close();
    };

    closeBtn.onclick = () => dialog.close();

    dialog.appendChild(generateBtn);
    dialog.appendChild(regenBtn);
    dialog.appendChild(useBtn);
    dialog.appendChild(closeBtn);
}

function handleMouseEvent(evt)
{
    cursor = editor.getMousePos(evt);
}

function importModel(serializedModelData)
{
    // Stop playback to avoid glitching
    stopPlayback();

    model.deserialize(serializedModelData);
}

function openModelFile()
{
    let input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ncft,.json,application/json,application/JSON';

    input.onchange = (e) =>
    {
        if (!e || !e.target || !e.target.files)
            return;

        let file = e.target.files[0];
        if (!file)
            return;

        let reader = new FileReader();
        reader.readAsText(file, 'UTF-8');

        reader.onload = (e) =>
        {
            if (!e || !e.target)
                return;

            try
            {
                importModel(e.target.result);
            }
            catch (error)
            {
                errorDialog("Failed to load project file.");
            }

            // Clear any hash tag in the URL
            history.replaceState(null, null, ' ');
        }
    };

    input.click();
}

async function loadRemoteProjectByRef(projectRef)
{
    let response = await fetch('/projects/import_remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: projectRef }),
    });

    if (!response.ok)
        throw TypeError('Remote project import failed');

    let payload = await response.json();
    if (typeof payload?.data != 'string')
        throw TypeError('Invalid remote project data');

    importModel(payload.data);
}

function showLoadURLDialog()
{
    let dialog = new Dialog('Load project from URL/ID');

    let p = document.createElement('p');
    p.textContent = 'Enter a NoiseCraft URL (e.g. https://noisecraft.app/162) or project ID:';
    dialog.appendChild(p);

    let input = document.createElement('input');
    input.type = 'text';
    input.style.width = '95%';
    input.placeholder = 'https://noisecraft.app/162 or 162';
    dialog.appendChild(input);

    let loadBtn = document.createElement('button');
    loadBtn.className = 'form_btn';
    loadBtn.textContent = 'Load';

    let closeBtn = document.createElement('button');
    closeBtn.className = 'form_btn';
    closeBtn.textContent = 'Close';
    closeBtn.style.marginLeft = '8px';

    loadBtn.onclick = async () =>
    {
        try
        {
            dialog.hideError();
            let value = input.value.trim();
            if (!value)
                throw TypeError('Please enter a URL or project ID.');
            await loadRemoteProjectByRef(value);
            dialog.close();
        }
        catch (e)
        {
            console.log(e);
            dialog.showError(e.message || 'Failed to load remote project.');
        }
    };

    closeBtn.onclick = () => dialog.close();

    dialog.appendChild(loadBtn);
    dialog.appendChild(closeBtn);
}

function saveModelFile()
{
    // There is no JS API in most browsers to prompt a file download. Chrome has
    // a file system API, but as of writing other browsers have no equivalent.
    //
    // Instead, a download typically occurs when your browser opens a URL and
    // decides the content should be saved as a file (rather than displayed or
    // used in a window).
    //
    // To save our file here, we will ask the browser to open a special kind of
    // of URL that uses the blob protocol. Our URL will not point to an external
    // resource, instead it will contain all data we want the user to download.
    //
    // We can ask the browser to open our URL in a few different ways. Here, we
    // will simulate a link on the page being clicked. It's a good user
    // experience compared to opening the URL in a new tab or window, which
    // takes the user away from the current page.
    let a = document.createElement('a');

    // Generate a default save file name
    let saveFileName =`${inputProjectTitle.value || 'untitled_project'}.ncft`;
    saveFileName = saveFileName.toLowerCase();
    saveFileName = saveFileName.replace(/[^a-z0-9.]/gi, "_");

    // This is what the browser will name the download by default.
    //
    // If the browser is configured to automatically save downloads in a fixed
    // location, this will be the default name for the file. If a file already
    // exists with that name, the name will be modified to prevent a conflict
    // ("example.ncft" might become "example (1).ncft") or the user will be
    // asked what to do (replace, modify the name, or cancel the download).
    //
    // If the browser is configured to prompt the user for a save location, this
    // will be the default name in the save dialog. The user can usually change
    // the name if they would like.
    a.download = saveFileName;

    // This is the binary large object (blob) we would like to send to the user.
    let blob = new Blob(
        [model.serialize()],
        {type: 'application/json'}
    );

    // This is the URL we're asking the browser to open, which will prompt the
    // blob download.
    //
    // In major browsers, the maximum size for this URL is quite generous. It
    // should pose no problem here. See: https://stackoverflow.com/a/43816041
    a.href = window.URL.createObjectURL(blob);

    a.click();
}

function shareProject()
{
    sharing.shareProject(model);
}

function startPlayback()
{
    if (model.playing)
        return;

    console.log('starting playback');

    // Hide the play button
    btnPlay.style.display = 'none';
    btnStop.style.display = 'inline-flex';

    // Send the play action to the model
    model.update(new Play());
}

function stopPlayback()
{
    if (!model.playing)
        return;

    console.log('stopping playback');

    // Hide the stop button
    btnPlay.style.display = 'inline-flex';
    btnStop.style.display = 'none';

    // Send the stop action to the model
    model.update(new Stop());
}

// Warn users that NoiseCraft works best in Chrome
function browserWarning()
{
    console.log('browserWarning');

    let agent = navigator.userAgent;

    if (agent.includes('Chrome') || agent.includes('Edge') || agent.includes('Firefox'))
        return;

    if (localStorage.getItem('displayed_browser_warning'))
        return;

    let dialog = new Dialog('Your Browser is Unsupported :(');

    dialog.paragraph(
        'NoiseCraft uses new web audio API features and works best in Chrome or Edge ' +
        'web browsers. In other web browsers, you may find that it is not yet able to ' +
        'produce audio output.'
    );

    if (agent.includes('Firefox'))
    {
        dialog.paragraph(
            'Firefox will be fully supported once this bug is resolved: ' +
            '<a href="https://bugzilla.mozilla.org/show_bug.cgi?id=1572644" target=”_blank”>' +
            'https://bugzilla.mozilla.org/show_bug.cgi?id=1572644</a>'
        );
    }

    dialog.paragraph(
        'If you have time, please consider trying NoiseCraft in Google Chrome: ' +
        '<a href="https://chrome.google.com/" target=”_blank”>' +
        'https://chrome.google.com/</a>'
    )

    var okBtn = document.createElement('button');
    okBtn.className = 'form_btn';
    okBtn.appendChild(document.createTextNode('OK'));
    okBtn.onclick = evt => dialog.close();
    dialog.appendChild(okBtn);

    localStorage.setItem('displayed_browser_warning', true);
}

btnOpen.onclick = openModelFile;
btnLoadURL.onclick = showLoadURLDialog;
btnSave.onclick = saveModelFile;
btnGenerate.onclick = showGenerateDialog;
btnShare.onclick = shareProject;
btnPlay.onclick = startPlayback;
btnStop.onclick = stopPlayback;
