'use strict';

/* Magic Mirror
 * Module: MMM-Switch
 * 
 * MIT Licensed
 */

/* jshint node: true, esversion:6 */

const NodeHelper = require('node_helper');
const statistics = require('math-statistics');
const Gpio = require('onoff').Gpio;
let { usleep } = require('usleep');

module.exports = NodeHelper.create({
    // "Private" node helper configuration options.
    _config: {
        MICROSECONDS_PER_CM: 1e6 / 34321,
        SAMPLE_SIZE: 5,
        TRIGGER_PULSE_TIME: 10 // microseconds (us)
    },

    start: function () {
        this.config = {};
        this.started = false;
        this.mode = "off";
    },

    setupListener: function () {
        this.trigger = new Gpio(this.config.triggerPin, "out");
        this.echoLeft = new Gpio(this.config.echoLeftPin, "in", "both");
        this.echoRight = new Gpio(this.config.echoRightPin, "in", "both");
        this.startTick = { Left: [0, 0], Right: [0, 0] };
        this.lastDistance = { Left: 0.0, Right: 0.0 };
        this.measureLeftCb = this.measure.bind(this, "Left");
        this.measureRightCb = this.measure.bind(this, "Right");
    },

    startListener: function () {
        this.echoLeft.watch(this.measureLeftCb);
        this.echoRight.watch(this.measureRightCb);
        this.mode = "waiting";
        console.log('[' + this.name + '] Listeners set up and started');
        this.sampleInterval = setInterval(this.doTrigger.bind(this), this.config.sampleInterval);
    },

    stopListener: function () {
        this.echoLeft.unwatch(this.measureLeftCb);
        this.echoRight.unwatch(this.measureRightCb);
        this.mode = "off";
        console.log('[' + this.name + '] Listeners stopped');
        clearInterval(this.sampleInterval);
    },

    doTrigger: function () {
        // Set trigger high for 10 microseconds
        this.trigger.writeSync(1);
        usleep(this._config.TRIGGER_PULSE_TIME);
        this.trigger.writeSync(0);
    },

    measure: function (which, err, value) {
        var diff, usDiff, dist;
        if (err) {
            throw err;
        }

        if (value == 1) {
            this.startTick[which] = process.hrtime();
        } else {
            diff = process.hrtime(this.startTick[which]);
            usleep(600);
            // Full conversion of hrtime to us => [0]*1000000 + [1]/1000
            usDiff = diff[0] * 1000000 + diff[1] / 1000;

            dist = (usDiff / 2 / this._config.MICROSECONDS_PER_CM).toFixed(0);
            if (((which === "Left" && dist >this.config.leftDistance) ||
                (which === "Right" && dist > this.config.rightDistance)) &&
                dist > this.config.maxDistance) {
                // console.log('[' + this.name + '] Sensor timeout');
                return;
            }

            this.lastDistance[which] = dist;

            if (this.config.calibrate) {
                // console.log('[' + this.name + ']' + this.lastDistance["Left"] + ", " + this.lastDistance["Right"]);
                this.sendSocketNotification('CALIBRATION', this.lastDistance);
            }

            if (this.mode === "waiting") {
                this.monitor(which, dist);
            } else if (this.mode === "detect") {
                this.detect(which, dist);
            }
        }
    },

    // monitor waits for the start of a switch
    monitor: function (which, dist) {
        if ((which === "Left" && dist <= this.config.leftDistance) ||
            (which === "Right" && dist <= this.config.rightDistance)) {
            var countdownTime = this.config.switchDuration / this._config.SAMPLE_SIZE;
            this.mode = "detect";
            this.gestureInfo = {
                distances: { Right: [], Left: [] },
                count: { Right: 0, Left: 0 },
                starter: which,
            };

            // we add the dist as a dict, so the entries are sorted by creation not by values
            this.gestureInfo.distances[which].push({ 'dist': dist });
            this.gestureInfo.count[which]++;
            // Maybe a swipe starts, so we measure more often (countdownTime instead of sampleInterval)
            clearInterval(this.sampleInterval);
            this.sampleInterval = setInterval(this.doTrigger.bind(this), countdownTime);
        }
    },

    // detect trys to detect a swipe, which already started
    detect: function (which, dist) {
        // todo: refactor since we always add dist ???
        if (this.gestureInfo.count[which] < this._config.SAMPLE_SIZE) {
            // if dist is valid (<= maxDistance)
            if (dist <= this.config.maxDistance) {
                this.gestureInfo.distances[which].push({ 'dist': dist });
                this.gestureInfo.count[which]++;
            }
        }
        if (this.gestureInfo.count.Left === this._config.SAMPLE_SIZE ||
            this.gestureInfo.count.Right === this._config.SAMPLE_SIZE) {
            this.processSwitch();
            usleep(this.config.latency);
        }
    },

    // We collected SAMPLE_SIZE measurements for both sensors, now we check if we have swipe
    processSwitch: function () {
        this.mode = "waiting";

        let current = this.gestureInfo.current;
        if (this.config.verbose) {
            console.log('[' + this.name + "] -------------------------");
            console.log('[' + this.name + "]   Current: " + current);
            console.log('[' + this.name + "]   Distances : " + JSON.stringify(this.gestureInfo.distances[current]));
        }

        // Change interval back from countdownTime to sampleInterval
        clearInterval(this.sampleInterval);
        this.sampleInterval = setInterval(this.doTrigger.bind(this), this.config.sampleInterval);

        let sum = 0;
        for (var i = 0; i < this._config.SAMPLE_SIZE; i++) {
            sum += parseInt(this.gestureInfo.distances[current][i]["dist"]);
        }

        let avg = sum / this._config.SAMPLE_SIZE;

        if ((current == 'Left' && 
            avg >= this.config.leftDistance) ||
            (current == 'Right' &&
            avg >= this.config.rightDistance)) {
            this.sendSocketNotification('SWITCH', current);
        }  
    },

    socketNotificationReceived: function (notification, payload) {
        if (notification === 'CONFIG') {
            if (!this.started) {
                this.config = payload;
                this.setupListener();
                this.started = true;
            }
            if (this.config.autoStart) {
                this.startListener();
            }
        } else if (notification === 'START') {
            this.startListener();
        } else if (notification === 'STOP') {
            this.stopListener();
        } else if (notification === 'STATUS') {
            console.log('[' + this.name + '] ' + payload);
        }
    },
});
