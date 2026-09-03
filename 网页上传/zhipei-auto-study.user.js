// ==UserScript==
// @name         江西省补贴性线上职业技能培训管理平台 自动刷课脚本
// @name:zh-CN   江西省补贴性线上职业技能培训管理平台 自动刷课脚本
// @name:en     ZhiPeiZaiXian Auto-Study Assistant
// @namespace    https://github.com/DDDdingdongji/zhipei-auto-study
// @version      3.0.0
// @description  自动连播、强制静音、完整播放到结束、验证码自动识别（需配合本地识别服务）、自动进入下一节、每日重置的播放时长记录
// @description:zh-CN  自动连播、强制静音、完整播放到结束、验证码自动识别（需配合本地识别服务）、自动进入下一节、每日重置的播放时长记录
// @description:en  Auto-play with forced mute, watch-to-the-end, auto captcha solving (requires local OCR server), auto next unit, daily playtime record
// @author       DDDdingdongji
// @license      MIT
// @match        https://jiangxi.zhipeizaixian.com/study*
// @icon         https://i.zpimg.cn/public_read/%E6%B1%9F%E8%A5%BFpc_16838203danjzg8w.png
// @homepageURL  https://github.com/DDDdingdongji/zhipei-auto-study
// @supportURL   https://github.com/DDDdingdongji/zhipei-auto-study/issues
// @downloadURL  https://github.com/DDDdingdongji/zhipei-auto-study/raw/main/zhipei-auto-study.user.js
// @updateURL    https://github.com/DDDdingdongji/zhipei-auto-study/raw/main/zhipei-auto-study.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================
    // 全局状态
    // =========================================================

    let enabled = true;
    let forceMute = true;
    let forcePlay = true;

    let videoTimer = null;
    let urlMonitor = null;

    let currentVideo = null;
    let currentVideoEndHandler = null;

    // 用于防止结束逻辑重复执行
    let finishing = false;

    // 当前是否因为人机验证而暂停
    let verificationPaused = false;


    // =========================================================
    // 验证码自动识别配置
    // =========================================================

    // 本地识别服务地址（运行识别服务后生效）
    const OCR_SERVER = 'http://127.0.0.1:8765';

    // 每次弹出验证最多尝试次数（失败会自动“换一张”重试）
    const OCR_MAX_RETRY = 3;

    // 自动识别开关（面板里可切换）
    let autoVerify = true;

    // 是否正在识别中（防并发）
    let solving = false;

    // 当前弹窗是否已触发过识别
    let solveTriggered = false;


    // =========================================================
    // 播放记录（核心）
    //
    // 1. 累计播放时长：
    //    只有视频真实处于“播放中”状态才计时，
    //    验证暂停 / 手动暂停 / 缓冲 / 已结束 一律不计入。
    //
    // 2. 验证暂停与恢复事件：
    //    检测到人机验证并暂停时记录 pause_verify，
    //    验证消失恢复播放时记录 resume_verify，
    //    每条事件带时间戳、unit_id、视频进度、当时累计时长。
    //
    // 3. 数据持久化到 localStorage（key: as_playback_record），
    //    页面跳转、关闭浏览器后记录仍然保留。
    //
    // 4. 每天自动重置：跨天时把前一天的总时长归档到历史
    //    （保留最近30天），当天的累计时长从 0 重新开始。
    // =========================================================

    const RECORD_KEY = 'as_playback_record';
    const MAX_RECORD_EVENTS = 300;
    const MAX_HISTORY_DAYS = 30;

    // 本次会话正在记录的小节
    let currentRecordUnitId = null;

    // 上一次计时的时刻（毫秒时间戳），0 表示不计时
    let lastPlayTick = 0;

    let playedEl = null;
    let recordModal = null;

    let playbackRecord = loadPlaybackRecord();

    const EVENT_TYPE_LABELS = {
        start: '▶ 开始播放',
        pause_verify: '⏸ 验证暂停',
        resume_verify: '▶ 验证后继续',
        ended: '⏹ 播放结束',
        stop: '⏹ 手动停止'
    };


    function getTodayKey() {

        const d = new Date();

        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');

        return `${y}-${m}-${day}`;
    }


    function makeEmptyRecord() {

        return {
            version: 2,
            dayKey: getTodayKey(),
            totalPlaySeconds: 0,
            units: {},
            events: [],
            history: [],
            updatedAt: null
        };
    }


    function archiveRecordToHistory(record) {

        if (!record) {
            return;
        }

        const unitIds = Object.keys(
            record.units || {}
        );

        // 没有实际播放过就不归档，避免产生空历史
        if (
            record.totalPlaySeconds <= 0 &&
            unitIds.length === 0
        ) {
            return;
        }

        let pauseCount = 0;
        let resumeCount = 0;

        for (const id of unitIds) {

            const u = record.units[id];

            pauseCount += u.pauseCount || 0;
            resumeCount += u.resumeCount || 0;
        }

        const history = Array.isArray(record.history)
            ? record.history
            : [];

        const entry = {
            day: record.dayKey || '未知日期',
            totalPlaySeconds: record.totalPlaySeconds,
            pauseCount,
            resumeCount,
            unitCount: unitIds.length
        };

        // 同一天已归档过则覆盖，防止出现重复行
        if (
            history.length &&
            history[history.length - 1].day === entry.day
        ) {
            history[history.length - 1] = entry;
        } else {
            history.push(entry);
        }

        while (history.length > MAX_HISTORY_DAYS) {
            history.shift();
        }

        record.history = history;
    }


    function resetRecordForToday() {

        archiveRecordToHistory(playbackRecord);

        const fresh = makeEmptyRecord();

        fresh.history = Array.isArray(
            playbackRecord.history
        ) ? playbackRecord.history : [];

        playbackRecord = fresh;

        savePlaybackRecord();
        updatePlaybackDisplay();

        console.log(
            '[自动刷课] 已跨天，今日观看时长重置为 0'
        );
    }


    function ensureTodayRecord() {

        if (
            playbackRecord.dayKey !==
            getTodayKey()
        ) {
            resetRecordForToday();
        }
    }


    function loadPlaybackRecord() {

        const empty = makeEmptyRecord();

        try {

            const raw =
                localStorage.getItem(RECORD_KEY);

            if (!raw) {
                return empty;
            }

            const parsed = JSON.parse(raw);

            if (
                !parsed ||
                typeof parsed !== 'object' ||
                typeof parsed.totalPlaySeconds !== 'number' ||
                typeof parsed.units !== 'object' ||
                !Array.isArray(parsed.events)
            ) {
                return empty;
            }

            if (!Array.isArray(parsed.history)) {
                parsed.history = [];
            }

            const today = getTodayKey();


            // -------------------------------------------------
            // 每天重置
            // -------------------------------------------------

            if (parsed.dayKey !== today) {

                // 旧版本没有 dayKey，
                // 用 updatedAt 推断数据归属日期：
                // 如果是今天产生的数据，直接保留并补上 dayKey。
                if (!parsed.dayKey && parsed.updatedAt) {

                    const d =
                        new Date(parsed.updatedAt);

                    const inferred =
                        `${d.getFullYear()}-` +
                        `${String(d.getMonth() + 1).padStart(2, '0')}-` +
                        `${String(d.getDate()).padStart(2, '0')}`;

                    if (inferred === today) {

                        parsed.dayKey = today;
                        parsed.version = 2;

                        return parsed;
                    }

                    parsed.dayKey = inferred;
                }


                // 跨天：旧数据归档到历史，当天从 0 开始
                archiveRecordToHistory(parsed);

                const fresh = makeEmptyRecord();

                fresh.history = parsed.history;

                console.log(
                    '[自动刷课] 检测到新的一天，' +
                    '观看时长重置为 0'
                );

                return fresh;
            }

            return parsed;

        } catch (e) {

            console.warn(
                '[自动刷课] 无法读取播放记录，改用内存记录',
                e
            );

            return empty;
        }
    }


    function savePlaybackRecord() {

        playbackRecord.updatedAt =
            new Date().toISOString();

        try {

            localStorage.setItem(
                RECORD_KEY,
                JSON.stringify(playbackRecord)
            );

        } catch (e) {

            console.warn(
                '[自动刷课] 播放记录保存失败（仅保存在内存中）',
                e
            );
        }
    }


    function getUnitRecord(unitId) {

        if (!unitId) {
            return null;
        }

        if (!playbackRecord.units[unitId]) {

            playbackRecord.units[unitId] = {
                playSeconds: 0,
                pauseCount: 0,
                resumeCount: 0,
                lastVideoTime: 0
            };
        }

        return playbackRecord.units[unitId];
    }


    function safeVideoTime(video) {

        try {

            if (
                video &&
                typeof video.currentTime === 'number'
            ) {
                return (
                    Math.round(video.currentTime * 10) / 10
                );
            }

        } catch (e) {}

        return 0;
    }


    function formatSeconds(total) {

        if (!Number.isFinite(total) || total < 0) {
            total = 0;
        }

        total = Math.floor(total);

        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;

        const mm = String(m).padStart(2, '0');
        const ss = String(s).padStart(2, '0');

        return h > 0
            ? `${h}:${mm}:${ss}`
            : `${mm}:${ss}`;
    }


    function addPlaySeconds(seconds, unitId) {

        if (!(seconds > 0)) {
            return;
        }

        playbackRecord.totalPlaySeconds += seconds;

        if (unitId) {

            const unit =
                getUnitRecord(unitId);

            if (unit) {
                unit.playSeconds += seconds;
            }
        }

        savePlaybackRecord();
        updatePlaybackDisplay();
    }


    function recordEvent(type, unitId, video) {

        const unit =
            unitId ? getUnitRecord(unitId) : null;

        const videoTime =
            safeVideoTime(video);

        if (unit) {

            if (type === 'pause_verify') {
                unit.pauseCount += 1;
            }

            if (type === 'resume_verify') {
                unit.resumeCount += 1;
            }

            if (videoTime > 0) {
                unit.lastVideoTime = videoTime;
            }
        }

        playbackRecord.events.push({
            t: new Date().toISOString(),
            type,
            unitId: unitId || null,
            videoTime,
            totalPlaySeconds: playbackRecord.totalPlaySeconds,
            unitPlaySeconds: unit ? unit.playSeconds : 0
        });

        // 只保留最近 N 条，防止无限增长
        if (
            playbackRecord.events.length >
            MAX_RECORD_EVENTS
        ) {

            playbackRecord.events.splice(
                0,
                playbackRecord.events.length -
                MAX_RECORD_EVENTS
            );
        }

        savePlaybackRecord();
        updatePlaybackDisplay();

        console.log(
            '[自动刷课] 记录事件:',
            type,
            'unit_id=' + (unitId || '-'),
            'videoTime=' + videoTime,
            '累计=' + formatSeconds(
                playbackRecord.totalPlaySeconds
            )
        );
    }


    function updatePlaybackDisplay() {

        if (!playedEl) {
            return;
        }

        playedEl.textContent =
            formatSeconds(
                playbackRecord.totalPlaySeconds
            );

        playedEl.title =
            '今日累计播放时长（每天自动重置为 0）';
    }


    // =========================================================
    // 播放记录（弹窗）
    // =========================================================

    function buildRecordModal() {

        if (recordModal) {
            return recordModal;
        }

        recordModal = document.createElement('div');
        recordModal.id = 'as-record-modal';

        recordModal.innerHTML = `
            <div class="mask"></div>
            <div class="box">
                <div class="box-head">
                    <span>📋 播放记录</span>
                    <span class="close">✕</span>
                </div>
                <div class="box-summary"></div>
                <div class="box-list"></div>
                <div class="box-actions">
                    <button class="act" data-act="copy">复制</button>
                    <button class="act" data-act="refresh">刷新</button>
                    <button class="act danger" data-act="clear">清空</button>
                    <button class="act" data-act="close">关闭</button>
                </div>
            </div>
        `;

        document.body.appendChild(recordModal);

        recordModal.querySelector('.close')
            .addEventListener('click', closeRecordModal);

        recordModal.querySelector('.mask')
            .addEventListener('click', closeRecordModal);

        recordModal
            .querySelectorAll('.box-actions .act')
            .forEach(btn => {

                btn.addEventListener('click', () => {

                    const act =
                        btn.getAttribute('data-act');

                    if (act === 'copy') {
                        copyRecordText();
                    } else if (act === 'refresh') {
                        renderRecordModal();
                    } else if (act === 'clear') {
                        clearPlaybackRecord();
                    } else {
                        closeRecordModal();
                    }
                });
            });

        return recordModal;
    }


    function openRecordModal() {

        buildRecordModal();

        recordModal.classList.add('open');

        renderRecordModal();
    }


    function closeRecordModal() {

        if (recordModal) {
            recordModal.classList.remove('open');
        }
    }


    function renderRecordModal() {

        if (!recordModal) {
            return;
        }

        const summaryEl =
            recordModal.querySelector('.box-summary');

        const listEl =
            recordModal.querySelector('.box-list');

        const currentUnitId =
            currentRecordUnitId ||
            getCurrentUnitId();

        const unit =
            currentUnitId
                ? playbackRecord.units[currentUnitId]
                : null;

        const summaryParts = [
            `今日累计播放：<b>${formatSeconds(playbackRecord.totalPlaySeconds)}</b>`
        ];

        if (currentUnitId && unit) {

            summaryParts.push(
                `本节：<b>${formatSeconds(unit.playSeconds)}</b>` +
                `（验证暂停 ${unit.pauseCount} 次 / 继续 ${unit.resumeCount} 次）`
            );
        }

        const history = Array.isArray(
            playbackRecord.history
        ) ? playbackRecord.history : [];

        if (history.length) {

            summaryParts.push('── 历史每日累计 ──');

            for (const h of history.slice().reverse()) {

                summaryParts.push(
                    `${h.day}：<b>${formatSeconds(h.totalPlaySeconds)}</b>` +
                    `（暂停 ${h.pauseCount} 次 / 继续 ${h.resumeCount} 次）`
                );
            }
        }

        summaryEl.innerHTML =
            summaryParts.join('<br>');

        const events =
            playbackRecord.events;

        if (!events.length) {

            listEl.innerHTML =
                '<div class="item">暂无记录</div>';

            return;
        }

        const rows = events
            .slice(-150)
            .reverse()
            .map(ev => {

                const label =
                    EVENT_TYPE_LABELS[ev.type] ||
                    ev.type;

                const timeText =
                    (ev.t || '')
                        .slice(5, 19)
                        .replace('T', ' ');

                return (
                    '<div class="item">' +
                    `<span class="type-${ev.type}">${label}</span>` +
                    ` ${timeText}` +
                    (ev.unitId ? ` · unit=${ev.unitId}` : '') +
                    (ev.videoTime > 0 ? ` · 视频 ${ev.videoTime}s` : '') +
                    ` · 累计 ${formatSeconds(ev.totalPlaySeconds)}` +
                    '</div>'
                );
            });

        listEl.innerHTML = rows.join('');
    }


    function recordToText() {

        const lines = [
            '自动刷课 · 播放记录',
            `导出时间：${new Date().toLocaleString()}`,
            `今日累计播放：${formatSeconds(playbackRecord.totalPlaySeconds)}`,
            ''
        ];

        const unitIds = Object.keys(
            playbackRecord.units
        );

        if (unitIds.length) {

            lines.push('各小节累计：');

            for (const id of unitIds) {

                const u =
                    playbackRecord.units[id];

                lines.push(
                    `- ${id}：${formatSeconds(u.playSeconds)}，` +
                    `验证暂停 ${u.pauseCount} 次 / 继续 ${u.resumeCount} 次，` +
                    `最后视频进度 ${u.lastVideoTime}s`
                );
            }

            lines.push('');
        }

        const history = Array.isArray(
            playbackRecord.history
        ) ? playbackRecord.history : [];

        if (history.length) {

            lines.push('历史每日累计（最近30天）：');

            for (const h of history.slice().reverse()) {

                lines.push(
                    `- ${h.day}：${formatSeconds(h.totalPlaySeconds)}，` +
                    `验证暂停 ${h.pauseCount} 次 / 继续 ${h.resumeCount} 次，` +
                    `共 ${h.unitCount} 节`
                );
            }

            lines.push('');
        }

        lines.push('事件明细：');

        for (const ev of playbackRecord.events) {

            const label =
                EVENT_TYPE_LABELS[ev.type] || ev.type;

            lines.push(
                `- [${ev.t}] ${label}` +
                ` unit=${ev.unitId || '-'}` +
                ` 视频 ${ev.videoTime}s` +
                ` 累计 ${formatSeconds(ev.totalPlaySeconds)}`
            );
        }

        return lines.join('\n');
    }


    function fallbackCopy(text) {

        try {

            const ta =
                document.createElement('textarea');

            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';

            document.body.appendChild(ta);
            ta.select();

            document.execCommand('copy');
            ta.remove();

            updateStatus('记录已复制到剪贴板');

        } catch (e) {

            updateStatus('复制失败，已输出到控制台');

            console.log(
                '[自动刷课] 播放记录：\n' + text
            );
        }
    }


    function copyRecordText() {

        const text = recordToText();

        try {

            navigator.clipboard.writeText(text)
                .then(() => {

                    updateStatus(
                        '记录已复制到剪贴板'
                    );
                })
                .catch(() => {
                    fallbackCopy(text);
                });

        } catch (e) {
            fallbackCopy(text);
        }
    }


    function clearPlaybackRecord() {

        if (
            !confirm(
                '确定清空全部播放记录？' +
                '（累计时长和事件日志都会被删除）'
            )
        ) {
            return;
        }

        playbackRecord = makeEmptyRecord();

        savePlaybackRecord();
        updatePlaybackDisplay();
        renderRecordModal();

        updateStatus('播放记录已清空');
    }


    // =========================================================
    // UI
    // =========================================================

    const ui = document.createElement('div');

    ui.id = 'as-panel';

    ui.innerHTML = `
        <style>
            #as-panel {
                position: fixed;
                bottom: 20px;
                right: 20px;
                width: 250px;
                background: rgba(0, 0, 0, 0.88);
                color: #fff;
                border-radius: 10px;
                z-index: 999999;
                font-family: Arial, sans-serif;
                font-size: 13px;
                box-shadow: 0 0 15px rgba(0, 0, 0, 0.7);
                overflow: hidden;
            }

            #as-panel .head {
                padding: 10px;
                background: #333;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                user-select: none;
            }

            #as-panel .body {
                padding: 10px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }

            #as-panel .row {
                display: flex;
                justify-content: space-between;
                align-items: center;
            }

            #as-panel button {
                padding: 7px;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                color: white;
            }

            #as-panel button:hover {
                opacity: 0.88;
            }

            #as-panel .btn-red {
                background: #c0392b;
            }

            #as-panel .btn-green {
                background: #27ae60;
            }

            #as-panel .btn-blue {
                background: #2980b9;
            }

            #as-panel .btn-purple {
                background: #8e44ad;
            }

            #as-panel .switch {
                width: 36px;
                height: 18px;
                background: #666;
                border-radius: 9px;
                cursor: pointer;
                position: relative;
                transition: background 0.3s;
            }

            #as-panel .switch.on {
                background: #4caf50;
            }

            #as-panel .switch::after {
                content: '';
                position: absolute;
                width: 16px;
                height: 16px;
                background: white;
                border-radius: 50%;
                top: 1px;
                left: 1px;
                transition: left 0.3s;
            }

            #as-panel .switch.on::after {
                left: 19px;
            }

            #as-panel .status {
                font-size: 11px;
                color: #aaa;
                line-height: 1.4;
                word-break: break-all;
            }

            #as-panel .warning {
                color: #ffd54f;
            }

            #as-record-modal {
                display: none;
                position: fixed;
                inset: 0;
                z-index: 1000000;
            }

            #as-record-modal.open {
                display: block;
            }

            #as-record-modal .mask {
                position: absolute;
                inset: 0;
                background: rgba(0, 0, 0, 0.55);
            }

            #as-record-modal .box {
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: 440px;
                max-width: 92vw;
                max-height: 80vh;
                background: #1e1e1e;
                color: #eee;
                border-radius: 10px;
                display: flex;
                flex-direction: column;
                font-family: Arial, sans-serif;
                font-size: 12px;
                box-shadow: 0 0 20px rgba(0, 0, 0, 0.8);
            }

            #as-record-modal .box-head {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px 12px;
                background: #333;
                border-radius: 10px 10px 0 0;
                font-size: 13px;
                user-select: none;
            }

            #as-record-modal .close {
                cursor: pointer;
                padding: 0 4px;
            }

            #as-record-modal .box-summary {
                padding: 8px 12px;
                border-bottom: 1px solid #444;
                line-height: 1.6;
                max-height: 150px;
                overflow: auto;
            }

            #as-record-modal .box-list {
                flex: 1;
                overflow: auto;
                padding: 6px 12px;
                min-height: 120px;
            }

            #as-record-modal .box-list .item {
                padding: 5px 0;
                border-bottom: 1px dashed #3a3a3a;
                line-height: 1.5;
                word-break: break-all;
            }

            #as-record-modal .box-list .type-start {
                color: #90caf9;
            }

            #as-record-modal .box-list .type-pause_verify {
                color: #ffd54f;
            }

            #as-record-modal .box-list .type-resume_verify {
                color: #81c784;
            }

            #as-record-modal .box-list .type-ended {
                color: #64b5f6;
            }

            #as-record-modal .box-list .type-stop {
                color: #ef9a9a;
            }

            #as-record-modal .box-actions {
                display: flex;
                gap: 6px;
                padding: 10px 12px;
                border-top: 1px solid #444;
            }

            #as-record-modal .box-actions .act {
                flex: 1;
                padding: 6px 0;
                border: none;
                border-radius: 4px;
                background: #2980b9;
                color: #fff;
                cursor: pointer;
                font-size: 12px;
            }

            #as-record-modal .box-actions .act.danger {
                background: #c0392b;
            }
        </style>

        <div class="head">
            <span>🎧 自动刷课 v3.0</span>
            <span id="as-arrow" style="font-size:14px;">▼</span>
        </div>

        <div class="body">

            <div class="status" id="as-status">
                启动中...
            </div>

            <div class="row">
                <span>今日播放</span>
                <span
                    id="as-played"
                    style="color:#ffd54f;font-weight:bold;"
                >00:00</span>
            </div>

            <div class="row">
                <span>强制播放</span>
                <div class="switch on" id="as-force"></div>
            </div>

            <div class="row">
                <span>静音</span>
                <div class="switch on" id="as-mute"></div>
            </div>

            <div class="row">
                <span>自动验证</span>
                <div class="switch on" id="as-verify"></div>
            </div>

            <button class="btn-blue" id="as-next">
                ⏭ 下一节
            </button>

            <button class="btn-purple" id="as-log">
                📋 播放记录
            </button>

            <button class="btn-red" id="as-stop">
                ⏹ 停止自动
            </button>

            <button
                class="btn-green"
                id="as-start"
                style="display:none;"
            >
                ▶ 开始自动
            </button>

        </div>
    `;

    document.body.appendChild(ui);

    const statusEl = ui.querySelector('#as-status');
    const btnStop = ui.querySelector('#as-stop');
    const btnStart = ui.querySelector('#as-start');
    const btnNext = ui.querySelector('#as-next');
    const btnLog = ui.querySelector('#as-log');

    const swForce = ui.querySelector('#as-force');
    const swMute = ui.querySelector('#as-mute');
    const swVerify = ui.querySelector('#as-verify');

    const body = ui.querySelector('.body');
    const head = ui.querySelector('.head');
    const arrow = ui.querySelector('#as-arrow');

    playedEl = ui.querySelector('#as-played');


    // =========================================================
    // UI事件
    // =========================================================

    head.addEventListener('click', () => {
        const hidden = body.style.display === 'none';

        body.style.display = hidden ? '' : 'none';
        arrow.textContent = hidden ? '▼' : '▶';
    });


    function updateStatus(message) {
        if (!message) {
            statusEl.textContent = enabled
                ? '运行中'
                : '已停止';
        } else {
            statusEl.textContent = message;
        }

        statusEl.classList.toggle(
            'warning',
            typeof message === 'string' &&
            (
                message.includes('验证码') ||
                message.includes('人机验证') ||
                message.includes('人工')
            )
        );
    }


    // =========================================================
    // 停止所有自动操作
    // =========================================================

    function stopVideoTimer() {
        if (videoTimer) {
            clearInterval(videoTimer);
            videoTimer = null;
        }
    }


    function removeVideoListener() {
        if (
            currentVideo &&
            currentVideoEndHandler
        ) {
            try {
                currentVideo.removeEventListener(
                    'ended',
                    currentVideoEndHandler
                );
            } catch (e) {}
        }

        currentVideo = null;
        currentVideoEndHandler = null;
    }


    function cleanupVideo() {
        stopVideoTimer();
        removeVideoListener();
    }


    function stopAll() {
        enabled = false;
        finishing = false;
        verificationPaused = false;

        // 记录手动停止
        if (currentRecordUnitId) {
            recordEvent(
                'stop',
                currentRecordUnitId,
                currentVideo
            );
        }

        lastPlayTick = 0;

        cleanupVideo();

        if (urlMonitor) {
            clearInterval(urlMonitor);
            urlMonitor = null;
        }

        sessionStorage.removeItem('auto_task');
        sessionStorage.removeItem('auto_next');
        sessionStorage.removeItem('last_finished_unit');

        const video = document.querySelector('video');

        if (video) {
            try {
                video.pause();
            } catch (e) {}
        }

        btnStop.style.display = 'none';
        btnStart.style.display = 'block';

        updateStatus('已停止');

        console.log('[自动刷课] 已停止');
    }


    function startAll() {
        enabled = true;
        finishing = false;
        verificationPaused = false;

        lastPlayTick = Date.now();

        btnStop.style.display = 'block';
        btnStart.style.display = 'none';

        updateStatus('运行中');

        startUrlMonitor();
        run();

        console.log('[自动刷课] 已启动');
    }


    // =========================================================
    // 开关
    // =========================================================

    swForce.addEventListener('click', () => {

        forcePlay = !forcePlay;

        swForce.classList.toggle(
            'on',
            forcePlay
        );

        updateStatus(
            forcePlay
                ? '强制播放：开启'
                : '强制播放：关闭'
        );
    });


    swMute.addEventListener('click', () => {

        forceMute = !forceMute;

        swMute.classList.toggle(
            'on',
            forceMute
        );

        const video = document.querySelector('video');

        if (video) {
            applyMuteState(video);
        }

        updateStatus(
            forceMute
                ? '静音：开启'
                : '静音：关闭'
        );
    });


    swVerify.addEventListener('click', () => {

        autoVerify = !autoVerify;

        swVerify.classList.toggle(
            'on',
            autoVerify
        );

        updateStatus(
            autoVerify
                ? '自动验证：开启（需本地识别服务）'
                : '自动验证：关闭（验证时暂停等人工）'
        );
    });


    btnStop.addEventListener(
        'click',
        stopAll
    );


    btnStart.addEventListener(
        'click',
        startAll
    );


    btnLog.addEventListener(
        'click',
        openRecordModal
    );


    // =========================================================
    // 手动下一节
    // =========================================================

    btnNext.addEventListener('click', () => {

        const params =
            new URLSearchParams(
                location.search
            );

        const courseId =
            params.get('course_id');

        const classId =
            params.get('class_id');

        if (!courseId || !classId) {
            updateStatus('缺少 course_id / class_id');
            return;
        }

        cleanupVideo();

        sessionStorage.removeItem(
            'auto_task'
        );

        sessionStorage.setItem(
            'auto_next',
            '1'
        );

        location.href =
            `/study?course_id=${courseId}&class_id=${classId}`;
    });


    // =========================================================
    // 等待元素
    // =========================================================

    function waitFor(selector, timeout = 15000) {

        return new Promise(resolve => {

            const start = Date.now();

            function check() {

                if (!enabled) {
                    resolve(null);
                    return;
                }

                const element =
                    document.querySelector(selector);

                if (element) {
                    resolve(element);
                    return;
                }

                if (
                    Date.now() - start >= timeout
                ) {
                    resolve(null);
                    return;
                }

                requestAnimationFrame(check);
            }

            check();
        });
    }


    // =========================================================
    // 判断视频页面
    // =========================================================

    function isVideoPage() {
        return location.pathname.includes(
            '/study/video'
        );
    }


    // =========================================================
    // 静音
    // =========================================================

    function applyMuteState(video) {

        if (!video) return;

        if (forceMute) {

            try {
                video.muted = true;
            } catch (e) {}

            try {
                video.volume = 0;
            } catch (e) {}

            /*
             * 某些播放器会不断恢复 muted / volume，
             * 因此尝试覆盖属性。
             */
            try {
                Object.defineProperty(
                    video,
                    'muted',
                    {
                        get: () => true,
                        set: () => {},
                        configurable: true
                    }
                );
            } catch (e) {}

            try {
                Object.defineProperty(
                    video,
                    'volume',
                    {
                        get: () => 0,
                        set: () => {},
                        configurable: true
                    }
                );
            } catch (e) {}

            // 播放器UI静音按钮
            try {

                const icon =
                    document.querySelector(
                        '.prism-volume .volume-icon'
                    );

                if (
                    icon &&
                    !icon.classList.contains('mute')
                ) {
                    icon.dispatchEvent(
                        new MouseEvent(
                            'click',
                            { bubbles: true }
                        )
                    );
                }

            } catch (e) {}

            // AliPlayer等播放器对象
            try {

                const playerContainer =
                    document.getElementById(
                        'J_prismPlayer'
                    );

                const player =
                    playerContainer?._player ||
                    playerContainer?.player ||
                    playerContainer?.aliplayer;

                if (
                    player &&
                    typeof player.mute === 'function'
                ) {
                    player.mute();
                }

            } catch (e) {}

        } else {

            try {
                Object.defineProperty(
                    video,
                    'muted',
                    {
                        writable: true,
                        configurable: true
                    }
                );
            } catch (e) {}

            try {
                Object.defineProperty(
                    video,
                    'volume',
                    {
                        writable: true,
                        configurable: true
                    }
                );
            } catch (e) {}

            try {
                video.muted = false;
                video.volume = 1;
            } catch (e) {}
        }
    }


    // =========================================================
    // 人机验证检测
    //
    // 检测到验证弹窗后：
    //   1. 暂停视频并记录 pause_verify
    //   2. 交给「自动识别」流程尝试解题并提交
    //      （验证码图片 → 本地 OCR 服务 → 填答案 → 点确定）
    //   3. 自动识别失败时保留人工兜底
    // =========================================================

    function detectVerification() {

        /*
         * 这些选择器用于检测可能出现的验证容器。
         * 平台前端版本变化后，实际 class 可能改变。
         */

        const selectors = [

            // 之前版本中观察到的候选元素
            '.zhipei-modal-content',
            '.code_box___32BrH',
            '.video_box___2zomT',

            // 常见验证码/验证弹窗关键词相关元素
            '[class*="captcha"]',
            '[class*="Captcha"]',
            '[class*="verify"]',
            '[class*="Verify"]',
            '[class*="verification"]',
            '[class*="Verification"]',

            // 常见弹窗
            '[role="dialog"]'
        ];


        for (const selector of selectors) {

            let elements;

            try {
                elements =
                    document.querySelectorAll(
                        selector
                    );
            } catch (e) {
                continue;
            }

            for (const el of elements) {

                if (!el) continue;

                const style =
                    window.getComputedStyle(el);

                if (
                    style.display === 'none' ||
                    style.visibility === 'hidden' ||
                    style.opacity === '0'
                ) {
                    continue;
                }

                const rect =
                    el.getBoundingClientRect();

                if (
                    rect.width <= 0 ||
                    rect.height <= 0
                ) {
                    continue;
                }

                const text =
                    (el.innerText || '')
                    .trim();

                /*
                 * 防止普通dialog / 普通播放器控件
                 * 被误认为验证码。
                 */
                const keywords = [
                    '验证码',
                    '图形验证',
                    '安全验证',
                    '人机验证',
                    '验证身份',
                    '请输入答案',
                    '请输入结果',
                    '计算',
                    'captcha'
                ];

                const lowerText =
                    text.toLowerCase();

                const matched =
                    keywords.some(
                        word =>
                            lowerText.includes(
                                word.toLowerCase()
                            )
                    );

                if (
                    matched ||
                    selector.includes('captcha') ||
                    selector.includes('Captcha') ||
                    selector.includes('verification') ||
                    selector.includes('Verification')
                ) {
                    return el;
                }
            }
        }

        return null;
    }


    // =========================================================
    // 验证检测
    // =========================================================

    function checkVerification(video) {

        const verifyBox =
            detectVerification();

        if (verifyBox) {

            if (!verificationPaused) {

                verificationPaused = true;

                try {
                    video.pause();
                } catch (e) {}

                // 记录：因验证而暂停
                recordEvent(
                    'pause_verify',
                    currentRecordUnitId,
                    video
                );

                updateStatus(
                    '⚠ 检测到人机验证，正在自动识别...'
                );

                console.warn(
                    '[自动刷课] 检测到人机验证，' +
                    '自动化播放已暂停'
                );
            }

            // 触发自动识别（每次弹窗只触发一次）
            if (
                autoVerify &&
                !solveTriggered &&
                !solving
            ) {
                solveTriggered = true;
                startAutoSolve();
            }

            return true;
        }


        // 验证框消失
        if (verificationPaused) {

            verificationPaused = false;
            solveTriggered = false;

            updateStatus(
                `继续播放 ${getCurrentUnitId() || ''}`
            );

            console.log(
                '[自动刷课] 验证窗口消失，恢复播放'
            );

            if (
                forcePlay &&
                video &&
                video.paused &&
                !video.ended
            ) {

                video.play().catch(() => {});
            }

            // 记录：验证后恢复播放
            recordEvent(
                'resume_verify',
                currentRecordUnitId,
                video
            );
        }

        return false;
    }


    // =========================================================
    // 验证码自动识别（本地 OCR 服务）
    //
    // 流程：
    //   1. 在验证弹窗内找到验证码图片（img 或背景图）
    //   2. 图片转 base64（canvas / fetch 回退）
    //   3. POST 到本地识别服务 captcha_server.py
    //   4. 服务返回 算式答案 / 5位数字串
    //   5. 填入输入框 → 点击确定
    //   6. 弹窗未消失则点“看不清,换一张”刷新后重试
    // =========================================================

    function sleep(ms) {

        return new Promise(resolve =>
            setTimeout(resolve, ms)
        );
    }


    // ---------------------------------------------------------
    // 在弹窗内定位验证码图片
    // 返回 { img } 或 { url }（背景图时）
    // ---------------------------------------------------------

    function findCaptchaSource(box) {

        if (!box) return null;

        const visible = el => {

            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();

            return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0' &&
                rect.width > 0 &&
                rect.height > 0
            );
        };

        const captchaLike = el => {

            const rect = el.getBoundingClientRect();

            return (
                rect.width >= 40 &&
                rect.width <= 600 &&
                rect.height >= 20 &&
                rect.height <= 300
            );
        };

        // 1) 优先 img
        const imgs = box.querySelectorAll('img');

        for (const img of imgs) {

            if (
                !visible(img) ||
                !captchaLike(img)
            ) {
                continue;
            }

            const src =
                img.currentSrc || img.src || '';

            if (src) {
                return { img, url: src };
            }
        }

        // 2) 背景图元素（排除含输入控件的大容器）
        const all = box.querySelectorAll('*');

        for (const el of all) {

            if (
                !visible(el) ||
                !captchaLike(el)
            ) {
                continue;
            }

            // 整个弹窗/表单容器不算验证码图片
            if (
                el.querySelector(
                    'input, button, textarea'
                )
            ) {
                continue;
            }

            let bg = '';

            try {
                bg = window.getComputedStyle(el)
                    .backgroundImage;
            } catch (e) {
                continue;
            }

            const m = bg && bg.match(
                /url\(["']?(.*?)["']?\)/
            );

            if (m && m[1] && !m[1].startsWith('data:')) {
                return { img: null, url: m[1] };
            }
        }

        return null;
    }


    // ---------------------------------------------------------
    // 图片 → base64 dataURL
    // ---------------------------------------------------------

    function imageToBase64(img) {

        // 方案1：canvas（同源图片最可靠）
        try {

            const canvas =
                document.createElement('canvas');

            canvas.width =
                img.naturalWidth || img.width || 0;

            canvas.height =
                img.naturalHeight || img.height || 0;

            if (canvas.width > 0 && canvas.height > 0) {

                const ctx =
                    canvas.getContext('2d');

                ctx.drawImage(
                    img,
                    0,
                    0,
                    canvas.width,
                    canvas.height
                );

                const dataUrl =
                    canvas.toDataURL('image/png');

                if (dataUrl && dataUrl.length > 100) {
                    return Promise.resolve(dataUrl);
                }
            }

        } catch (e) {
            // 跨域图片 canvas 被污染，走方案2/3
        }

        const src = img.currentSrc || img.src || '';

        // 方案2：src 本身就是 dataURL
        if (src.startsWith('data:image')) {
            return Promise.resolve(src);
        }

        // 方案3：fetch 图片（同源或 CORS 允许时）
        return fetch(src)
            .then(res => res.blob())
            .then(blob => new Promise((resolve, reject) => {

                const reader = new FileReader();

                reader.onload = () =>
                    resolve(reader.result);

                reader.onerror = () =>
                    reject(new Error('FileReader 失败'));

                reader.readAsDataURL(blob);
            }))
            .catch(() => null);
    }


    // ---------------------------------------------------------
    // 调用本地识别服务
    // ---------------------------------------------------------

    async function solveViaServer(imageDataUrl, srcUrl) {

        const payload = {
            image: imageDataUrl || null,
            url: (!imageDataUrl && srcUrl) ? srcUrl : null
        };

        const body = JSON.stringify(payload);

        // 优先 fetch；页面 CSP 拦截时回退 GM_xmlhttpRequest
        try {

            const resp = await fetch(
                OCR_SERVER + '/solve',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body
                }
            );

            if (!resp.ok) {
                throw new Error('HTTP ' + resp.status);
            }

            return resp.json();

        } catch (fetchError) {

            if (typeof GM_xmlhttpRequest !== 'function') {
                throw fetchError;
            }

            return new Promise((resolve, reject) => {

                GM_xmlhttpRequest({
                    method: 'POST',
                    url: OCR_SERVER + '/solve',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    data: body,
                    timeout: 30000,
                    onload: res => {
                        try {
                            resolve(JSON.parse(res.responseText));
                        } catch (e) {
                            reject(e);
                        }
                    },
                    onerror: reject,
                    ontimeout: () =>
                        reject(new Error('识别服务超时'))
                });
            });
        }
    }


    // ---------------------------------------------------------
    // React 兼容地填输入框
    // ---------------------------------------------------------

    function fillVerificationInput(box, value) {

        const inputs = box.querySelectorAll(
            'input, textarea'
        );

        let target = null;

        for (const input of inputs) {

            const style = window.getComputedStyle(input);

            if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                input.type === 'hidden'
            ) {
                continue;
            }

            const rect = input.getBoundingClientRect();

            if (rect.width <= 0 || rect.height <= 0) {
                continue;
            }

            target = input;
            break;
        }

        if (!target) {
            throw new Error('未找到输入框');
        }

        // React 受控组件必须走原生 setter + input 事件
        const proto =
            target.tagName === 'TEXTAREA'
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;

        const setter = Object.getOwnPropertyDescriptor(
            proto,
            'value'
        ).set;

        if (setter) {
            setter.call(target, String(value));
        } else {
            target.value = String(value);
        }

        target.dispatchEvent(
            new Event('input', { bubbles: true })
        );

        target.dispatchEvent(
            new Event('change', { bubbles: true })
        );

        return target;
    }


    // ---------------------------------------------------------
    // 元素查找 / 模拟点击 / 提交
    // ---------------------------------------------------------

    const CONFIRM_TEXTS = ['确定', '提交', '确认'];
    const REFRESH_TEXTS = ['看不清', '换一张', '刷新'];


    function isVisibleEl(el) {

        if (!el) return false;

        try {

            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();

            return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0' &&
                rect.width > 0 &&
                rect.height > 0
            );

        } catch (e) {
            return false;
        }
    }


    function normText(el) {

        return (el.textContent || '')
            .replace(/\s+/g, '')
            .trim();
    }


    // ---------------------------------------------------------
    // 多级查找按钮：
    //   1. box 内部（按钮类元素优先）
    //   2. box 所属弹窗容器内部
    //   3. 全文档（离 box 中心最近的匹配元素）
    // 解决「输入框在 box 里、确定按钮在弹窗 footer 里」的错位问题
    // ---------------------------------------------------------

    function findButtonByText(box, texts, interactiveOnly) {

        const matchIn = list => {

            for (const el of list) {

                if (!isVisibleEl(el)) continue;

                const text = normText(el);

                if (
                    text.length > 0 &&
                    text.length <= 12 &&
                    texts.some(t => text.includes(t))
                ) {
                    return el;
                }
            }

            return null;
        };

        // 1) box 内
        if (box) {

            const r1 = matchIn(
                box.querySelectorAll(
                    'button, [role="button"], a, ' +
                    'input[type="button"], input[type="submit"]'
                )
            );

            if (r1) return r1;

            if (!interactiveOnly) {

                const r2 = matchIn(
                    box.querySelectorAll('div, span, i, b, em')
                );

                if (r2) return r2;
            }
        }

        // 2) 弹窗容器内（box 的祖先）
        if (box) {

            let dialog = null;

            try {
                dialog = box.closest(
                    '[role="dialog"], ' +
                    '[class*="modal" i], [class*="Modal"], ' +
                    '[class*="dialog" i], [class*="Dialog"]'
                );
            } catch (e) {}

            if (dialog && dialog !== box) {

                const r3 = matchIn(
                    dialog.querySelectorAll(
                        'button, [role="button"], a, ' +
                        'input[type="button"], input[type="submit"]'
                    )
                );

                if (r3) return r3;
            }
        }

        // 3) 全文档：离 box 中心最近的候选（交互类元素加分）
        let center = { x: window.innerWidth / 2,
                       y: window.innerHeight / 2 };

        if (box) {

            const r = box.getBoundingClientRect();

            center = {
                x: r.left + r.width / 2,
                y: r.top + r.height / 2
            };
        }

        const all = document.querySelectorAll(
            'button, [role="button"], a, ' +
            'input[type="button"], input[type="submit"], ' +
            (interactiveOnly ? '' : 'div, span')
        );

        let best = null;
        let bestScore = Infinity;

        for (const el of all) {

            if (!isVisibleEl(el)) continue;

            const text = normText(el);

            if (
                text.length <= 0 ||
                text.length > 12 ||
                !texts.some(t => text.includes(t))
            ) {
                continue;
            }

            const r = el.getBoundingClientRect();

            if (r.width <= 0 || r.height <= 0) {
                continue;
            }

            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;

            const dist = Math.hypot(
                cx - center.x,
                cy - center.y
            );

            // 非交互类元素（div/span）扣分，避免误点容器
            const interactive =
                /^(BUTTON|A|INPUT)$/i.test(el.tagName) ||
                el.getAttribute('role') === 'button';

            const score = dist + (interactive ? 0 : 400);

            if (score < bestScore) {
                bestScore = score;
                best = el;
            }
        }

        return best;
    }


    // ---------------------------------------------------------
    // 完整鼠标事件序列点击（兼容只监听 mousedown/pointer 的组件）
    // ---------------------------------------------------------

    function clickElement(el) {

        if (!el) return false;

        try {

            const opts = {
                bubbles: true,
                cancelable: true,
                view: window
            };

            el.dispatchEvent(
                new MouseEvent('pointerdown', opts)
            );

            el.dispatchEvent(
                new MouseEvent('mousedown', opts)
            );

            el.dispatchEvent(
                new MouseEvent('pointerup', opts)
            );

            el.dispatchEvent(
                new MouseEvent('mouseup', opts)
            );

            el.dispatchEvent(
                new MouseEvent('click', opts)
            );

            el.click();

            return true;

        } catch (e) {
            return false;
        }
    }


    // ---------------------------------------------------------
    // Enter 键提交（很多验证表单支持回车提交）
    // ---------------------------------------------------------

    function pressEnter(input) {

        if (!input) return false;

        try {

            input.focus();

            for (const type of
                 ['keydown', 'keypress', 'keyup']) {

                input.dispatchEvent(
                    new KeyboardEvent(type, {
                        key: 'Enter',
                        code: 'Enter',
                        keyCode: 13,
                        which: 13,
                        bubbles: true,
                        cancelable: true
                    })
                );
            }

            return true;

        } catch (e) {
            return false;
        }
    }


    // ---------------------------------------------------------
    // 表单提交（requestSubmit 会触发 React onSubmit）
    // ---------------------------------------------------------

    function submitForm(input) {

        try {

            const form = input && input.closest('form');

            if (
                form &&
                typeof form.requestSubmit === 'function'
            ) {
                form.requestSubmit();
                return true;
            }

        } catch (e) {}

        return false;
    }


    // ---------------------------------------------------------
    // 自动识别主循环（每次弹窗触发一次）
    // ---------------------------------------------------------

    async function startAutoSolve() {

        if (solving || !enabled || !autoVerify) {
            return;
        }

        solving = true;

        updateStatus('⚠ 验证：自动识别中...');

        console.log('[自动刷课] 开始自动识别验证');

        try {

            for (let attempt = 0;
                 attempt < OCR_MAX_RETRY;
                 attempt++) {

                if (!enabled) {
                    break;
                }

                // 弹窗可能已经消失
                const box = detectVerification();

                if (!box) {
                    console.log(
                        '[自动刷课] 验证弹窗已消失，无需识别'
                    );
                    break;
                }

                const source = findCaptchaSource(box);

                if (!source) {
                    updateStatus(
                        '⚠ 验证：未找到验证码图片，请人工完成'
                    );
                    break;
                }

                // ---------------------------------------------
                // 取图并识别
                // ---------------------------------------------

                let imageDataUrl = null;

                if (source.img) {
                    imageDataUrl =
                        await imageToBase64(source.img);
                }

                if (!imageDataUrl && !source.url) {
                    updateStatus(
                        '⚠ 验证：验证码图片读取失败，请人工完成'
                    );
                    break;
                }

                const result = await solveViaServer(
                    imageDataUrl,
                    source.url
                );

                const value =
                    result.type === 'digit'
                        ? result.digits
                        : result.answer;

                console.log(
                    '[自动刷课] 识别结果:',
                    JSON.stringify(result)
                );

                // 置信度过低视为“识别失败”：不冒险提交错误答案
                const lowConf =
                    value &&
                    typeof result.confidence === 'number' &&
                    result.confidence < 0.30;

                if (!value || lowConf) {

                    // 识别失败（不是答错）：换一张验证码继续试
                    updateStatus(
                        (lowConf ? '识别置信度不足，' : '识别失败，') +
                        `换一张重试 (${attempt + 1}/${OCR_MAX_RETRY})`
                    );

                    console.warn(
                        '[自动刷课] 识别失败/低置信:',
                        JSON.stringify(result)
                    );

                    clickElement(
                        findButtonByText(box, REFRESH_TEXTS)
                    );

                    await sleep(1500);

                    continue;
                }

                // ---------------------------------------------
                // 填答案
                // ---------------------------------------------

                let targetInput = null;

                try {
                    targetInput =
                        fillVerificationInput(box, value);
                } catch (e) {
                    updateStatus(
                        '⚠ 验证：未找到输入框，请人工完成'
                    );
                    break;
                }

                console.log(
                    '[自动刷课] 输入框:',
                    targetInput.tagName,
                    targetInput.className
                );

                // 稍等让 React 提交受控组件的值
                await sleep(300);

                const actualValue =
                    (targetInput.value || '').trim();

                if (actualValue !== String(value).trim()) {

                    console.warn(
                        '[自动刷课] 输入框回读值不匹配:',
                        actualValue,
                        '期望:',
                        value
                    );
                }

                // ---------------------------------------------
                // 找确定按钮并点击
                // ---------------------------------------------

                let confirmBtn =
                    findButtonByText(box, CONFIRM_TEXTS);

                // 按钮文案为「验证」的平台
                // （仅找交互元素，避免误匹配“验证码”标签文字）
                if (!confirmBtn) {
                    confirmBtn = findButtonByText(
                        box,
                        ['验证'],
                        true
                    );
                }

                if (!confirmBtn) {

                    // 兜底：按弹窗右下角位置定位按钮
                    // （本平台“确定”按钮位于弹窗右下区域，
                    //   两张截图实测约在弹窗宽 90% / 高 91% 处）
                    try {

                        const dialog = box.closest(
                            '[role="dialog"], ' +
                            '[class*="modal" i], [class*="Modal"], ' +
                            '[class*="dialog" i], [class*="Dialog"]'
                        ) || box;

                        const r = dialog.getBoundingClientRect();

                        const x = r.left + r.width * 0.90;
                        const y = r.top + r.height * 0.91;

                        // 临时隐藏本脚本面板，避免遮挡按钮
                        const uiEl =
                            document.getElementById('as-panel');

                        if (uiEl) {
                            uiEl.style.display = 'none';
                        }

                        const el =
                            document.elementFromPoint(x, y);

                        if (uiEl) {
                            uiEl.style.display = '';
                        }

                        if (el && dialog.contains(el)) {

                            confirmBtn = el;

                            console.log(
                                '[自动刷课] 按位置定位到按钮:',
                                el.tagName,
                                el.className
                            );
                        }

                    } catch (e) {}
                }

                if (!confirmBtn) {

                    updateStatus(
                        '⚠ 验证：未找到确定按钮，请人工完成'
                    );

                    break;
                }

                // 按钮可能因受控状态未同步而禁用：
                // 反复触发 input 事件直到按钮可用
                for (let i = 0;
                     i < 5 &&
                     confirmBtn.disabled;
                     i++) {

                    fillVerificationInput(box, value);
                    await sleep(400);
                }

                if (confirmBtn.disabled) {

                    console.warn(
                        '[自动刷课] 确定按钮仍处于禁用状态，' +
                        '仍将尝试点击'
                    );
                }

                console.log(
                    '[自动刷课] 确定按钮:',
                    confirmBtn.tagName,
                    confirmBtn.className,
                    JSON.stringify(normText(confirmBtn)),
                    'disabled=' + confirmBtn.disabled
                );

                clickElement(confirmBtn);

                updateStatus(
                    `🤖 已自动填写验证：${value} ` +
                    `（第${attempt + 1}次）`
                );

                // ---------------------------------------------
                // 等待平台校验
                // ---------------------------------------------

                await sleep(2000);

                if (!detectVerification()) {

                    console.log(
                        '[自动刷课] 验证通过，弹窗已关闭'
                    );

                    updateStatus('✅ 验证通过，继续播放');

                    return;
                }

                // ---------------------------------------------
                // 未通过：Enter 提交 / 表单提交 兜底
                // ---------------------------------------------

                if (
                    pressEnter(targetInput) ||
                    submitForm(targetInput)
                ) {

                    updateStatus(
                        `已填写 ${value}，尝试回车提交...`
                    );

                    await sleep(1500);

                    if (!detectVerification()) {

                        console.log(
                            '[自动刷课] 回车提交成功，弹窗已关闭'
                        );

                        updateStatus('✅ 验证通过，继续播放');

                        return;
                    }
                }

                // ---------------------------------------------
                // 还在弹窗：刷新验证码再试
                // ---------------------------------------------

                updateStatus(
                    `验证未通过，换一张重试 ` +
                    `(${attempt + 1}/${OCR_MAX_RETRY})`
                );

                clickElement(
                    findButtonByText(box, REFRESH_TEXTS)
                );

                await sleep(1500);
            }

            updateStatus(
                '⚠ 自动识别未成功，请人工完成'
            );

        } catch (error) {

            console.error(
                '[自动刷课] 自动识别异常:',
                error
            );

            updateStatus(
                '⚠ 自动识别异常，请人工完成' +
                '（检查本地识别服务是否在运行）'
            );

        } finally {

            solving = false;
        }
    }


    function getCurrentUnitId() {

        return new URLSearchParams(
            location.search
        ).get('unit_id');
    }


    // =========================================================
    // 视频正常结束后返回目录
    // =========================================================

    function finishVideo(reason, task, params) {

        if (finishing) {
            return;
        }

        /*
         * 这里非常关键：
         *
         * 不接受“95%”
         * 不接受“剩余1秒”
         * 不接受“卡住5秒”
         *
         * 只有真正的 ended / 明确达到结束状态
         * 才调用这里。
         */

        finishing = true;

        const currentUnitId =
            params.get('unit_id');

        console.log(
            `[自动刷课] 视频确认结束：${reason}，unit_id=${currentUnitId}`
        );

        updateStatus(
            '本节播放结束，保存学习记录...'
        );

        // 记录：本节播放结束
        recordEvent(
            'ended',
            currentUnitId,
            currentVideo
        );

        cleanupVideo();

        sessionStorage.setItem(
            'last_finished_unit',
            currentUnitId
        );

        sessionStorage.removeItem(
            'auto_task'
        );

        sessionStorage.setItem(
            'auto_next',
            '1'
        );


        const cid =
            task.courseId ||
            params.get('course_id');

        const clid =
            task.classId ||
            params.get('class_id');


        /*
         * 比原脚本多等待一点时间。
         *
         * 目的不是等待播放器，
         * 而是尽量让平台完成当前学习记录的提交。
         */

        setTimeout(() => {

            if (!enabled) {
                return;
            }

            if (!cid || !clid) {

                updateStatus(
                    '播放结束，但缺少课程参数'
                );

                return;
            }

            location.href =
                `/study?course_id=${cid}&class_id=${clid}`;

        }, 1500);
    }


    // =========================================================
    // 视频页面
    // =========================================================

    async function handleVideo() {

        cleanupVideo();

        finishing = false;
        verificationPaused = false;


        const params =
            new URLSearchParams(
                location.search
            );

        const currentUnitId =
            params.get('unit_id');

        const taskRaw =
            sessionStorage.getItem(
                'auto_task'
            );


        // -----------------------------------------------------
        // 没有任务
        // -----------------------------------------------------

        if (!taskRaw) {

            updateStatus(
                '无任务，返回目录'
            );

            sessionStorage.setItem(
                'auto_next',
                '1'
            );

            const cid =
                params.get('course_id');

            const clid =
                params.get('class_id');

            if (cid && clid) {

                location.href =
                    `/study?course_id=${cid}&class_id=${clid}`;
            }

            return;
        }


        // -----------------------------------------------------
        // 读取任务
        // -----------------------------------------------------

        let task = null;

        try {
            task = JSON.parse(taskRaw);
        } catch (e) {
            task = null;
        }


        // -----------------------------------------------------
        // 任务不匹配
        // -----------------------------------------------------

        if (
            !task ||
            task.unitId !== currentUnitId
        ) {

            updateStatus(
                '任务不匹配，返回目录'
            );

            sessionStorage.removeItem(
                'auto_task'
            );

            sessionStorage.setItem(
                'auto_next',
                '1'
            );

            const cid =
                params.get('course_id') ||
                task?.courseId;

            const clid =
                params.get('class_id') ||
                task?.classId;

            if (cid && clid) {

                location.href =
                    `/study?course_id=${cid}&class_id=${clid}`;
            }

            return;
        }


        updateStatus(
            `加载视频 ${currentUnitId}`
        );

        console.log(
            `[自动刷课] 播放 unit_id=${currentUnitId}`
        );


        // -----------------------------------------------------
        // 等待 video
        // -----------------------------------------------------

        const video =
            await waitFor(
                'video',
                20000
            );

        if (!video) {

            updateStatus(
                '视频加载失败，等待页面'
            );

            return;
        }


        currentVideo = video;


        // -----------------------------------------------------
        // 初始化播放计时
        // -----------------------------------------------------

        currentRecordUnitId = currentUnitId;
        lastPlayTick = Date.now();

        recordEvent(
            'start',
            currentRecordUnitId,
            video
        );


        // -----------------------------------------------------
        // 首次静音
        // -----------------------------------------------------

        applyMuteState(video);


        // -----------------------------------------------------
        // 视频真正结束事件
        // -----------------------------------------------------

        const endedHandler = () => {

            if (!enabled) {
                return;
            }

            /*
             * 必须是真正的 ended 事件。
             */
            finishVideo(
                'HTMLVideoElement ended',
                task,
                params
            );
        };


        currentVideoEndHandler =
            endedHandler;


        video.addEventListener(
            'ended',
            endedHandler
        );


        // -----------------------------------------------------
        // 定时器
        // -----------------------------------------------------

        videoTimer =
            setInterval(() => {

                if (!enabled) {

                    stopVideoTimer();

                    return;
                }


                if (
                    !video ||
                    !document.contains(video)
                ) {
                    return;
                }


                const now = Date.now();


                // -------------------------------------------------
                // 每天重置检查
                //
                // 页面跨天不关闭时，
                // 同样把今日观看时长重置为 0。
                // -------------------------------------------------

                ensureTodayRecord();


                // -------------------------------------------------
                // 累计播放时长
                //
                // 只有视频真实处于播放状态才计时：
                // 验证暂停 / 手动暂停 / 缓冲中 / 已结束
                // 的时间都不会被计入。
                // -------------------------------------------------

                const isPlaying =
                    !video.paused &&
                    !video.ended &&
                    !verificationPaused &&
                    video.readyState >= 3;

                if (isPlaying && lastPlayTick > 0) {

                    addPlaySeconds(
                        (now - lastPlayTick) / 1000,
                        currentRecordUnitId
                    );
                }

                lastPlayTick = now;


                // -------------------------------------------------
                // 人机验证
                // -------------------------------------------------

                if (
                    checkVerification(video)
                ) {
                    return;
                }


                // -------------------------------------------------
                // 静音
                // -------------------------------------------------

                applyMuteState(video);


                // -------------------------------------------------
                // 自动播放
                // -------------------------------------------------

                if (
                    forcePlay &&
                    video.paused &&
                    !video.ended
                ) {

                    video.play().catch(() => {});


                    const bigPlay =
                        document.querySelector(
                            '.prism-big-play-btn'
                        );

                    if (bigPlay) {

                        try {

                            bigPlay.dispatchEvent(
                                new MouseEvent(
                                    'click',
                                    {
                                        bubbles: true
                                    }
                                )
                            );

                        } catch (e) {}
                    }
                }


                // -------------------------------------------------
                // 真正结束检测
                // -------------------------------------------------

                if (video.ended) {

                    finishVideo(
                        'interval检测到ended',
                        task,
                        params
                    );

                    return;
                }


                /*
                 * 非常重要：
                 *
                 * 这里故意没有：
                 *
                 * remaining < 1
                 * progress >= 0.95
                 * stuck >= 25
                 * currentTime > duration + 10
                 *
                 * 防止课程在最后几秒提前离开视频页。
                 */

            }, 500);


        // -----------------------------------------------------
        // 首次播放
        // -----------------------------------------------------

        if (!checkVerification(video)) {

            applyMuteState(video);


            if (
                forcePlay &&
                video.paused &&
                !video.ended
            ) {

                video.play().catch(() => {});
            }


            // 某些播放器需要点击大播放按钮
            const playBtn =
                await waitFor(
                    '.prism-big-play-btn',
                    5000
                );

            if (
                playBtn &&
                !video.ended &&
                !verificationPaused
            ) {

                try {

                    playBtn.dispatchEvent(
                        new MouseEvent(
                            'click',
                            {
                                bubbles: true
                            }
                        )
                    );

                } catch (e) {}
            }
        }


        updateStatus(
            `播放中 ${currentUnitId}`
        );
    }


    // =========================================================
    // 目录页面
    // =========================================================

    async function handleCatalog(
        retryCount = 0
    ) {

        if (!enabled) {
            return;
        }


        finishing = false;
        verificationPaused = false;


        const forceNext =
            sessionStorage.getItem(
                'auto_next'
            );


        if (forceNext === '1') {

            sessionStorage.removeItem(
                'auto_next'
            );

            updateStatus(
                '自动寻找下一节...'
            );

        } else {

            updateStatus(
                '扫描课程目录...'
            );
        }


        // -----------------------------------------------------
        // 等待目录标签
        // -----------------------------------------------------

        let tab = null;


        for (let i = 0; i < 30; i++) {

            if (!enabled) {
                return;
            }


            const tabs =
                document.querySelectorAll(
                    '.leftFate___1zL-W'
                );


            for (const t of tabs) {

                const span =
                    t.querySelector(
                        '.icon_text___BnIA_'
                    );

                if (
                    span &&
                    span.textContent.trim() === '目录'
                ) {

                    tab = t;
                    break;
                }
            }


            if (tab) {
                break;
            }


            await new Promise(
                resolve =>
                    setTimeout(resolve, 500)
            );
        }


        if (!tab) {

            updateStatus(
                '目录标签未找到'
            );

            return;
        }


        // -----------------------------------------------------
        // 打开目录
        // -----------------------------------------------------

        if (
            !tab.classList.contains(
                'fate_active___rKVF5'
            )
        ) {

            try {

                tab.dispatchEvent(
                    new MouseEvent(
                        'click',
                        {
                            bubbles: true
                        }
                    )
                );

            } catch (e) {}


            await new Promise(
                resolve =>
                    setTimeout(resolve, 600)
            );
        }


        // -----------------------------------------------------
        // 等待课程列表
        // -----------------------------------------------------

        const container =
            await waitFor(
                '.mulu_list___hpQAJ',
                5000
            );


        if (!container) {

            updateStatus(
                '目录未加载'
            );

            return;
        }


        // -----------------------------------------------------
        // 上一节完成记录
        // -----------------------------------------------------

        const lastFinished =
            sessionStorage.getItem(
                'last_finished_unit'
            );


        const rows =
            container.querySelectorAll(
                '.content_units_wrap___29R73'
            );


        // -----------------------------------------------------
        // 扫描课程
        // -----------------------------------------------------

        for (const row of rows) {

            if (!enabled) {
                return;
            }


            const right =
                row.querySelector(
                    '.units_right_box___xROhe'
                );


            if (!right) {
                continue;
            }


            // -------------------------------------------------
            // 已完成
            // -------------------------------------------------

            if (
                right.querySelector(
                    '.study_success_svg___Dc7SQ'
                )
            ) {
                continue;
            }


            // -------------------------------------------------
            // 获取 unit_id
            // -------------------------------------------------

            const link =
                row.querySelector(
                    'a.units_wrap_box___3DqST'
                );


            if (!link) {
                continue;
            }


            let rowUnitId = null;

            try {

                const url =
                    new URL(
                        link.href,
                        location.origin
                    );

                rowUnitId =
                    url.searchParams.get(
                        'unit_id'
                    );

            } catch (e) {
                continue;
            }


            if (!rowUnitId) {
                continue;
            }


            // -------------------------------------------------
            // 刚刚播放完成
            //
            // 防止平台状态尚未刷新时，
            // 又立即重新进入同一节。
            // -------------------------------------------------

            if (
                lastFinished &&
                rowUnitId === lastFinished
            ) {

                console.log(
                    `[自动刷课] 跳过刚完成 unit=${rowUnitId}`
                );

                continue;
            }


            // -------------------------------------------------
            // 未开始 / 学习中
            // -------------------------------------------------

            const notStarted =
                right.querySelector(
                    '.not_start___2H5mD'
                );

            const inProgress =
                right.querySelector(
                    '.progress_get_on___3F-Lx'
                );


            if (
                notStarted ||
                inProgress
            ) {

                const params =
                    new URLSearchParams(
                        location.search
                    );


                const taskData = {

                    courseId:
                        params.get(
                            'course_id'
                        ),

                    classId:
                        params.get(
                            'class_id'
                        ),

                    unitId:
                        rowUnitId
                };


                sessionStorage.setItem(
                    'auto_task',
                    JSON.stringify(taskData)
                );


                updateStatus(
                    `进入下一节：${rowUnitId}`
                );


                console.log(
                    `[自动刷课] 下一节 unit_id=${rowUnitId}`
                );


                location.href =
                    link.href;

                return;
            }
        }


        // -----------------------------------------------------
        // 没有找到下一节
        //
        // 检查刚完成课程是否还没刷新状态
        // -----------------------------------------------------

        if (lastFinished) {

            let stillExists = false;

            for (const row of rows) {

                const link =
                    row.querySelector(
                        'a.units_wrap_box___3DqST'
                    );


                if (!link) {
                    continue;
                }


                let rowUnitId = null;


                try {

                    const url =
                        new URL(
                            link.href,
                            location.origin
                        );

                    rowUnitId =
                        url.searchParams.get(
                            'unit_id'
                        );

                } catch (e) {
                    continue;
                }


                if (
                    rowUnitId ===
                    lastFinished
                ) {

                    const right =
                        row.querySelector(
                            '.units_right_box___xROhe'
                        );


                    if (
                        right &&
                        !right.querySelector(
                            '.study_success_svg___Dc7SQ'
                        )
                    ) {
                        stillExists = true;
                    }

                    break;
                }
            }


            // -------------------------------------------------
            // 等待服务器状态刷新
            // -------------------------------------------------

            if (
                stillExists &&
                retryCount < 5
            ) {

                updateStatus(
                    `等待学习状态更新... (${retryCount + 1}/5)`
                );


                console.log(
                    `[自动刷课] 等待 last_finished 状态刷新，` +
                    `重试 ${retryCount + 1}`
                );


                await new Promise(
                    resolve =>
                        setTimeout(resolve, 3000)
                );


                return handleCatalog(
                    retryCount + 1
                );
            }
        }


        // -----------------------------------------------------
        // 全部完成
        // -----------------------------------------------------

        updateStatus(
            '全部课程完成！'
        );


        console.log(
            '[自动刷课] 所有课程已完成'
        );


        alert(
            '🎉 所有课程已完成！'
        );


        stopAll();
    }


    // =========================================================
    // 主运行入口
    // =========================================================

    function run() {

        if (!enabled) {
            return;
        }


        cleanupVideo();


        if (isVideoPage()) {

            handleVideo().catch(error => {

                console.error(
                    '[自动刷课] handleVideo异常:',
                    error
                );

                updateStatus(
                    '视频处理出现异常'
                );
            });

        } else {

            handleCatalog().catch(error => {

                console.error(
                    '[自动刷课] handleCatalog异常:',
                    error
                );

                updateStatus(
                    '目录处理出现异常'
                );
            });
        }
    }


    // =========================================================
    // URL变化监控
    // =========================================================

    let lastUrl =
        location.href;


    function startUrlMonitor() {

        if (urlMonitor) {
            clearInterval(urlMonitor);
        }


        urlMonitor =
            setInterval(() => {

                // 每天重置检查（目录页等没有视频计时器的页面）
                ensureTodayRecord();

                if (
                    location.href !==
                    lastUrl
                ) {

                    lastUrl =
                        location.href;


                    console.log(
                        '[自动刷课] 检测到URL变化:',
                        lastUrl
                    );


                    if (enabled) {
                        run();
                    }
                }

            }, 1000);
    }


    // =========================================================
    // 启动
    // =========================================================

    run();
    startUrlMonitor();

    updateStatus(
        '运行中'
    );

    updatePlaybackDisplay();


    console.log(
        '[自动刷课] 自动连播引擎已启动' +
        '（播放时长每日自动重置）'
    );

})();
