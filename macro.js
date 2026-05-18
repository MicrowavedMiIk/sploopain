(function() {
    'use strict';

    // ----------------------------------------------------------------------
    // author: me
    // description: automates(you still have to click the keys) heal/spike/trap usage via websocket injection
    // NOTE: javascript is so weird, why is there no main() method
    // ----------------------------------------------------------------------

    // cooldowns are in ticks (120/sec)
    // heal = 4 ticks, spike = 2, trap = 3
    // took me way too long to figure these out, spent like 2 hours logging packets like an idiot
    // TODO: auto pearl or something maybe

    const TICKS_PER_SECOND = 120;
    const MS_PER_TICK = 1000 / TICKS_PER_SECOND;

    // opcodes i sniffed from the websocket
    // in java i would make these an enum but apparently you cant really do that here
    const Opcode = {
        SELECT: 0,
        ATTACK: 18,
        ROTATE: 19  
    };

    const ItemId = {
        FOOD:  2,
        SPIKE: 4,
        TRAP:  7
        // WALL: 3  -- tried this, server rejects it mid-combo for some reason, gave up
    };

    // javascript doesn't have static fields so i'm just putting these up here
    let _socketInstance = null;
    let _workerInstance = null;

    // probably doesn't matter at this scale but it felt wrong not to
    const _selectPacketBuffer = new Uint8Array([Opcode.SELECT, 0]);
    const _attackPacketBuffer = new Uint8Array([Opcode.ATTACK, 0]);
    const _rotatePacketBuffer = new Uint8Array([Opcode.ROTATE, 0, 0]);


    function createItemState(cooldownTicks) {
        return {
            isActive:      false,
            expiryTick:    0,
            cooldownTicks: cooldownTicks
        };
    }

    // Worker thread -- runs the tick loop so setTimeout doesn't get throttled
    // learned this the hard way, whole thing was stuttering because setTimeout was getting throttled to like 1/sec when the tab was in the background
    // and i thought my cooldown math was wrong which is not rare for me
    function workerEntryPoint() {
        const MS_PER_TICK = 1000 / 120;

        // would love to use a HashMap here but JS objects are apparently fine for this
        const itemStateMap = {
            heal:  { isActive: false, expiryTick: 0, cooldownTicks: 4 },
            spike: { isActive: false, expiryTick: 0, cooldownTicks: 2 },
            trap:  { isActive: false, expiryTick: 0, cooldownTicks: 3 }
        };

        const uiEnabledMap = {
            heal: true,
            spike: true,
            trap: true
        };

        let currentWeaponSlot = 0;
        let currentAngleDegrees = 0.0;
        let currentTick = 0;

        let accumulatorMs = 0;
        let lastTimestampMs = performance.now();


        // past me was really excited about binary packing for some reason
        let pendingCommandList = [];

        function tickLoop() {
            const nowMs = performance.now();
            let deltaMs = nowMs - lastTimestampMs;
            if (deltaMs > 250) deltaMs = 250;
            lastTimestampMs = nowMs;
            accumulatorMs += deltaMs;

            while (accumulatorMs >= MS_PER_TICK) {
                processTick(currentTick);
                currentTick++;
                accumulatorMs -= MS_PER_TICK;
            }

            if (pendingCommandList.length > 0) {
                self.postMessage({ type: 'cmds', data: pendingCommandList });
                pendingCommandList = [];  // clear -- in java i'd call .clear() on an ArrayList
            }

            setTimeout(tickLoop, 0);
        }

        function processTick(tickNumber) {
            // iterate over all items and check if they should fire
            // i miss enhanced for loops so much
            const itemKeys = Object.keys(itemStateMap);
            for (let i = 0; i < itemKeys.length; i++) {
                const itemName = itemKeys[i];
                const itemState = itemStateMap[itemName];

                if (uiEnabledMap[itemName] === false) continue;

                if (itemState.isActive === true && tickNumber >= itemState.expiryTick) {
                    pendingCommandList.push({
                        itemName:   itemName,
                        weaponSlot: currentWeaponSlot,
                        angleDeg:   currentAngleDegrees
                    });
                    itemState.expiryTick = tickNumber + itemState.cooldownTicks;
                }
            }
        }

        self.onmessage = function(e) {
            if (e.data === null || e.data === undefined) return; // null check, old habit
            const message = e.data;

            if (message.type === 'input') {
                // no ?. operator in older java so i keep forgetting it exists in JS
                itemStateMap.heal.isActive  = message.keys.KeyQ  === true;
                itemStateMap.spike.isActive = message.keys.KeyV  === true;
                itemStateMap.trap.isActive  = message.keys.KeyF  === true;
                if (message.keys.Digit1 === true) currentWeaponSlot = 0;
                if (message.keys.Digit2 === true) currentWeaponSlot = 1;
                currentAngleDegrees = message.angleDeg;
            } else if (message.type === 'ui_toggle') {
                uiEnabledMap[message.item] = message.enabled;
            } else if (message.type === 'start') {
                tickLoop();
            }
        };
    }
      

    function sendCommandsToServer(commandList) {
        if (_socketInstance === null || _socketInstance.readyState !== WebSocket.OPEN) {
            return; // would throw an exception in java but JS just lets you do this i guess
        }

        for (let i = 0; i < commandList.length; i++) {
            const command = commandList[i];

            let inventoryItemId = 0;
            if (command.itemName === 'heal')  inventoryItemId = ItemId.FOOD;
            if (command.itemName === 'spike') inventoryItemId = ItemId.SPIKE;
            if (command.itemName === 'trap')  inventoryItemId = ItemId.TRAP;

            _selectPacketBuffer[1] = inventoryItemId;
            _socketInstance.send(_selectPacketBuffer.buffer);

            // server wants a uint16 in range 0..65535 mapped to 0..2pi
            // not 100% sure this formula is right but it seems to work, don't ask me to explain it
            const angleRad = (command.angleDeg % 360) * Math.PI / 180;
            const quantizedAngle = Math.round(65535 * (angleRad + Math.PI) / (2 * Math.PI));
            _rotatePacketBuffer[1] = quantizedAngle & 0xFF;          // low byte
            _rotatePacketBuffer[2] = (quantizedAngle >> 8) & 0xFF;   // high byte
            _socketInstance.send(_rotatePacketBuffer.buffer);
            _socketInstance.send(_attackPacketBuffer.buffer);

            _selectPacketBuffer[1] = command.weaponSlot;
            _socketInstance.send(_selectPacketBuffer.buffer);
        }
    }


    function hookWebSocket() {
        const originalSendMethod = WebSocket.prototype.send;
        WebSocket.prototype.send = function(data) {
            if (_socketInstance === null) {
                // grab the first socket we see, should be the game
                // if there's ever a second one we're cooked but hasn't happened yet
                _socketInstance = this;
            }
            return originalSendMethod.apply(this, arguments);
        };
    }


    // yes serializing a function to a blob is cursed, no i don't want to hear about it
    function initializeWorkerThread() {
        const workerSourceCode = '(' + workerEntryPoint.toString() + ')()';
        const workerBlob = new Blob([workerSourceCode], { type: 'text/javascript' });
        _workerInstance = new Worker(URL.createObjectURL(workerBlob));

        _workerInstance.onmessage = function(e) {
            if (e.data.type === 'cmds') {
                sendCommandsToServer(e.data.data);
            }
        };

        _workerInstance.postMessage({ type: 'start' });
    }

    // i hate this shit so much, would be a breeze in java with swing or something
    function buildUserInterface() {
        const container = document.createElement('div');
        container.style.position = 'fixed';
        container.style.top = '40px';
        container.style.left = '40px';
        container.style.width = '180px';
        container.style.backgroundColor = 'rgba(24, 24, 28, 0.95)';
        container.style.border = '1px solid #3e3e4a';
        container.style.borderRadius = '4px';
        container.style.padding = '10px';
        container.style.fontFamily = 'monospace';
        container.style.color = '#e1e1e6';
        container.style.userSelect = 'none';
        container.style.zIndex = '99999';
        container.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.4)';

        // prevents the panel container from capturing focus on click
        container.addEventListener('mousedown', function(e) {
            e.preventDefault();
        });

        const titleBar = document.createElement('div');
        titleBar.textContent = '[ENG CORE MODULES]';
        titleBar.style.cursor = 'move';
        titleBar.style.color = '#569cd6';
        titleBar.style.fontWeight = 'bold';
        titleBar.style.borderBottom = '1px solid #3e3e4a';
        titleBar.style.paddingBottom = '4px';
        titleBar.style.marginBottom = '8px';
        container.appendChild(titleBar);

        function createRow(label, itemKey) {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.justifyContent = 'space-between';
            row.style.alignItems = 'center';
            row.style.marginBottom = '6px';

            const span = document.createElement('span');
            span.textContent = label;
            row.appendChild(span);

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = true;
            checkbox.style.cursor = 'pointer';
            checkbox.style.accentColor = '#569cd6';

            checkbox.addEventListener('change', function() {
                if (_workerInstance) {
                    _workerInstance.postMessage({
                        type: 'ui_toggle',
                        item: itemKey,
                        enabled: checkbox.checked
                    });
                }
            });

            row.appendChild(checkbox);
            container.appendChild(row);
        }

        createRow('Q - Heal', 'heal');
        createRow('V - Spike', 'spike');
        createRow('F - Trap', 'trap');

        document.body.appendChild(container);

        let dragActive = false;
        let startX = 0, startY = 0;

        titleBar.addEventListener('mousedown', function(e) {
            dragActive = true;
            startX = e.clientX - container.offsetLeft;
            startY = e.clientY - container.offsetTop;
        });

        document.addEventListener('mousemove', function(e) {
            if (!dragActive) return;
            container.style.left = (e.clientX - startX) + 'px';
            container.style.top = (e.clientY - startY) + 'px';
        });

        document.addEventListener('mouseup', function() {
            dragActive = false;
        });
    }


    function bindInputListeners() {
        const pressedKeys = {};  // HashMap<String, Boolean> basically
        let mouseAngleDegrees = 0.0;
        let gameCanvas = null;

        function syncInputToWorker() {
            if (_workerInstance === null) return;
            _workerInstance.postMessage({
                type:     'input',
                keys:     pressedKeys,
                angleDeg: mouseAngleDegrees
            });
        }

        document.addEventListener('mousemove', function(e) {
            if (gameCanvas === null) gameCanvas = document.getElementById('game-canvas');
            if (gameCanvas === null) return;

            const centerX = gameCanvas.clientWidth  / 2;
            const centerY = gameCanvas.clientHeight / 2;
            mouseAngleDegrees = Math.atan2(e.clientY - centerY, e.clientX - centerX) * (180.0 / Math.PI);
            syncInputToWorker();
        });

        window.addEventListener('keydown', function(e) {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (pressedKeys[e.code] === true) return; // already pressed, ignore repeat events
            pressedKeys[e.code] = true;
            syncInputToWorker();
        });

        window.addEventListener('keyup', function(e) {
            pressedKeys[e.code] = false;
            syncInputToWorker();
        });
    }

    // main() -- entry point (i know JS doesn't have this but it helps me think)
    function main() {
        hookWebSocket();
        initializeWorkerThread();
        buildUserInterface();
        bindInputListeners();
        console.log('pain is loaded');
    }

    main();

})();
