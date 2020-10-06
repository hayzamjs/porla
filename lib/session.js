const _ = require('lodash');
const { EventEmitter } = require('events');
const fs = require('./async-fs');
const logger = require('./logger');
const lt = require('libtorrent');
const path = require('path');
const { session_stats_metrics } = lt;
const Torrent = require('./torrent');

const metrics = session_stats_metrics().reduce((acc, curr) => {
    acc[curr.name] = {
        index: curr.value_index,
        type: curr.type
    };
    return acc;
}, {});

const emitter = new EventEmitter();
const internalEmitter = new EventEmitter();
const mutedTorrents = [];
const timers = {};
const torrents = new Map();
const initialMetadata = {};

let exiting = false;
let loadOptions = null;
let session = null;

async function saveTorrent(status) {
    const torrentsPath = path.join(loadOptions.dataPath, 'torrents');

    try {
        await fs.mkdir(torrentsPath, { recursive: true });
    } catch (err) {
        logger.error('Failed to create path "%s": %s', torrentsPath, err);
        // TODO: wrap the code below (saving torrent file and emitting event) in a
        // function, which is then called periodically for a maximum of X tries before
        // giving up
    }

    const ct = new lt.create_torrent(status.torrent_file);
    const buffer = ct.generate_buf();
    const p = path.join(torrentsPath, `${status.info_hash}.torrent`);

    logger.debug('Saving torrent file to "%s"', p)

    try {
        await fs.writeFile(p, buffer);
    } catch (err) {
        logger.error('Failed to write torrent file to "%s": %s', p, err);
        // TODO: see above todo about about retrying
    }
}

const init = (options) => {
    options = options || {};

    const sessionSettings = {
        alert_mask: lt.alert.all_categories,
        dht_bootstrap_nodes:`router.bittorrent.com:6881,router.utorrent.com:6881,dht.transmissionbt.com:6881,dht.aelitis.com:6881`,
        enable_dht: true,
        enable_lsd: true,
        in_enc_policy: 1, // enabled
        out_enc_policy: 1, // enabled
        peer_fingerprint: lt.generate_fingerprint('PO', 0, 0, 1),
        stop_tracker_timeout: 1,
        user_agent: 'Porla/alpha libtorrent/1.2.0'
    };

    // Custom DHT bootstrap nodes
    if (options.dht && Array.isArray(options.dht.bootstrapNodes)) {
        const nodes = options.dht.bootstrapNodes
            .map(val => `${val[0]}:${val[1]}`)
            .join(',');

        sessionSettings.dht_bootstrap_nodes = nodes;
    }

    if (options.dht && typeof options.dht.enabled === 'boolean') {
        sessionSettings.enable_dht = options.dht.enabled;
    }

    // Listen interfaces
    if (Array.isArray(options.listenInterfaces)) {
        const ifaces = options.listenInterfaces
            .map(val => `${val[0]}:${val[1]}`)
            .join(',');

        sessionSettings.listen_interfaces = ifaces;
    }

    // Require encryption, perhaps.
    if (typeof options.requireEncryption === 'boolean') {
        if (options.requireEncryption) {
            sessionSettings.in_enc_policy = 0; // forced
            sessionSettings.out_enc_policy = 0; // forced
        }
    }

    // Proxy
    if ('proxy' in options) {
        const { proxy } = options;

        sessionSettings.proxy_type     = proxy.type;
        sessionSettings.proxy_hostname = proxy.host;
        sessionSettings.proxy_port     = proxy.port;

        if (proxy.username) {
            sessionSettings.proxy_username = proxy.username;
        }

        if (proxy.password) {
            sessionSettings.proxy_password = proxy.password;
        }

        if (typeof proxy.force === 'boolean' && proxy.force) {
            sessionSettings.proxy_hostnames = true;
            sessionSettings.proxy_peer_connections = true;
            sessionSettings.proxy_tracker_connections = true;
        }

        logger.debug('Setting up session proxy');
    }

    session = new lt.session(sessionSettings);
}

const loadState = async (options) => {
    const stateFile = path.join(options.dataPath, 'state.dat');

    logger.info(`Loading session state from ${stateFile}`);

    try {
        const buffer = await fs.readFile(stateFile);
        session.load_state(buffer);
    } catch (err) {
        // We accept the ENOENT error since the data folder or state.dat
        // file might not exist yet.
        if (err.code !== 'ENOENT') {
            logger.error('Unknown error when loading state file: %s', err);
        }
    }
}

const loadTorrents = async (options) => {
    let files = [];

    const torrentsPath = path.join(options.dataPath, 'torrents');

    try {
        files = await fs.readdir(torrentsPath);
    } catch (err) {
        // We accept the ENOENT error since the data folder or state.dat
        // file might not exist yet.
        if (err.code !== 'ENOENT') {
            logger.error('Unknown error when loading torrent files: %s', err);
            return;
        }
    }

    const dats = files.filter(f => path.extname(f) === '.json');
    const items = [];

    logger.info('Loading %d torrent(s) from "%s"', dats.length, torrentsPath);

    for (const dat of dats) {
        const p = path.join(torrentsPath, dat);
        const buf = await fs.readFile(p);
        const decoded = JSON.parse(buf);

        if (decoded !== Object(decoded)) {
            logger.warn('.dat file (%s) not an object', p);
            // TODO: err for dat file. should log warn and remove
            // dat file and corresponding torrent file (if it exists)
            continue;
        }

        const resumeBuffer = Buffer.from(decoded.resume, 'base64');
        let queuePosition = Number.MAX_VALUE;

        if ('metadata' in decoded) {
            if (decoded.metadata !== Object(decoded.metadata)) {
                logger.warn('Torrent (%s) metadata not an object', p);
                continue;
            }

            initialMetadata[path.basename(dat, '.json')] = decoded.metadata;
        }

        if ('queuePosition' in decoded) {
            queuePosition = Number(decoded.queuePosition);
        }

        items.push({
            infoHash: path.basename(dat, '.json'),
            params: lt.read_resume_data(resumeBuffer),
            queuePosition: queuePosition,
        });
    }

    const sortedItems = _.sortBy(items, x => x.queuePosition);

    for (const item of sortedItems) {
        const tf = path.join(torrentsPath, `${item.infoHash}.torrent`);

        try {
            item.params.ti = new lt.torrent_info(tf);
        } catch (err) {
            logger.error('Error when parsing torrent file (%s): %s', tf, err);
            continue;
        }

        mutedTorrents.push(item.infoHash);

        session.async_add_torrent(item.params);
    }
}

const readAlerts = async () => {
    do {
        const foundAlerts = await waitForAlerts(100);

        if (!foundAlerts) {
            continue;
        }

        const alerts = session.pop_alerts();

        for (const alert of alerts) {
            switch(alert.what) {
                case 'add_torrent':
                    // TODO: check error

                    const status = alert.handle.status();
                    let muted = false;

                    logger.debug('Torrent "%s" added', status.info_hash);

                    // Check if this torrent is a muted torrent - i.e it
                    // was added as a part of the load function.
                    if (mutedTorrents.includes(status.info_hash)) {
                        const idx = mutedTorrents.indexOf(status.info_hash);
                        mutedTorrents.splice(idx, 1);
                        muted = true;
                    } else if(status.has_metadata) {
                        await saveTorrent(status);
                    }

                    const torrent = new Torrent(alert.handle);

                    if (torrent.infoHash in initialMetadata) {
                        torrent._metadata = { ...initialMetadata[torrent.infoHash] };
                        delete initialMetadata[torrent.infoHash];
                    }

                    if (!torrents.has(status.info_hash)) {
                        torrents.set(status.info_hash, torrent);
                    }

                    if (!muted) {
                        emitter.emit('torrent.added', { torrent });
                    }

                    break;

                case 'metadata_received':
                    await saveTorrent(alert.handle.status());
                    break;

                case 'session_stats':
                    const metricKeys = Object.keys(metrics);
                    const sessionStats = metricKeys.reduce((acc, curr, idx) => {
                        const metric = metricKeys[idx];
                        acc[metric] = alert.counters[metrics[metric].index];
                        return acc;
                    }, {});

                    emitter.emit('session.statistics', { stats: sessionStats });
                    break;

                case 'state_update':
                    const torrentsStats = alert.status.reduce((acc, curr) => {
                        acc.downloadPayloadRate += curr.download_payload_rate;
                        acc.uploadPayloadRate += curr.upload_payload_rate;
                        return acc;
                    }, {
                        downloadPayloadRate: 0,
                        uploadPayloadRate: 0
                    });

                    emitter.emit('torrents.statistics', { stats: torrentsStats });

                    const updatedTorrents = [];

                    for (const status of alert.status) {
                        const updatedTorrent = torrents.get(status.info_hash);
                        updatedTorrent._status = status;

                        updatedTorrents.push(updatedTorrent);
                    }

                    if (updatedTorrents.length > 0) {
                        emitter.emit('torrents.updated', { torrents: updatedTorrents });
                    }
                    break;

                case 'storage_moved':
                    const smTorrent = torrents.get(alert.handle.info_hash());
                    smTorrent._status = alert.handle.status();
                    smTorrent.emit('storage_moved');
                    break;

                case 'storage_moved_failed':
                    const smfTorrent = torrents.get(alert.handle.info_hash());
                    smfTorrent.emit('storage_moved_failed', { error: alert.error });
                    break;

                case 'torrent_finished':
                    const finishedTorrent = torrents.get(alert.handle.info_hash());
                    finishedTorrent._status = alert.handle.status();

                    if (finishedTorrent._status.total_payload_download > 0) {
                        emitter.emit('torrent.finished', { torrent: finishedTorrent });
                    }
                    break;

                case 'torrent_paused':
                    const pausedTorrent = torrents.get(alert.handle.info_hash());
                    pausedTorrent.emit('paused');
                    emitter.emit('torrent.paused', { torrent: pausedTorrent });
                    break;

                case 'torrent_removed':
                    const removedTorrent = torrents.get(alert.info_hash);
                    removedTorrent.emit('removed');
                    torrents.delete(alert.info_hash);
                    emitter.emit('torrent.removed', { torrent: { infoHash: alert.info_hash } });

                    // Remove torrent and dat file (if any)
                    const torrentsPath = path.join(loadOptions.dataPath, 'torrents');
                    const stateFile = path.join(torrentsPath, `${alert.info_hash}.json`);
                    const torrentFile = path.join(torrentsPath, `${alert.info_hash}.torrent`);

                    try {
                        await fs.unlink(stateFile);
                    } catch {}

                    try {
                        await fs.unlink(torrentFile);
                    } catch {}

                    break;
            }
        }
    } while (!exiting);

    internalEmitter.emit('readAlerts.finished');
}

const unload = () => {
    return new Promise((resolve, reject) => {
        logger.debug('Starting to unload session');

        internalEmitter.once('readAlerts.finished', async () => {
            logger.debug('Saving session state');

            clearInterval(timers.postUpdates);

            const state = session.save_state_buf(lt.save_state_flags.save_dht_state);
            const torrentsPath = path.join(loadOptions.dataPath, 'torrents');

            try {
                await fs.mkdir(loadOptions.dataPath);
            } catch (err) { }

            try {
                await fs.mkdir(torrentsPath);
            } catch (err) { }

            try {
                await fs.writeFile(path.join(loadOptions.dataPath, 'state.dat'), state);
            } catch (err) {
                this._logger.error('Failed to save session state');
            }

            logger.debug('Pausing session');

            session.pause();

            let numOutstandingResumeData = 0;
            const tempStatus = session.get_torrent_status();

            for (const st of tempStatus) {
                if (!st.handle.is_valid() || !st.has_metadata || !st.need_save_resume) {
                    continue;
                }

                st.handle.save_resume_data();
                numOutstandingResumeData += 1;
            }

            logger.info('Saving resume data for %d torrents', numOutstandingResumeData);

            while (numOutstandingResumeData > 0) {
                const foundAlerts = await waitForAlerts(1000);
                if (!foundAlerts) { continue; }

                const alerts = session.pop_alerts();

                for (const alert of alerts) {
                    if (alert.what === 'torrent_paused') {
                        continue;
                    }

                    if (alert.what === 'save_resume_data_failed') {
                        numOutstandingResumeData -= 1;
                        continue;
                    }

                    if (alert.what !== 'save_resume_data') {
                        continue;
                    }

                    numOutstandingResumeData -= 1;

                    const statePath = path.join(torrentsPath, `${alert.handle.info_hash()}.json`);
                    const status = alert.handle.status();

                    const state = {
                        metadata: torrents.get(alert.handle.info_hash()).metadata,
                        resume: lt.write_resume_data_buf(alert.params).toString('base64'),
                        queuePosition: status.queue_position
                    };

                    await fs.writeFile(statePath, JSON.stringify(state, null, 2));
                }
            }

            return resolve();
        });

        exiting = true;
    });
}

const waitForAlerts = (timeout) => {
    return new Promise((resolve, reject) => {
        session.wait_for_alert(timeout, (err, result) => {
            if (err) {
                return reject(err);
            }

            return resolve(result);
        });
    });
}

function parseOptions(params, options) {
    params.save_path = options.savePath || loadOptions.savePath || '.';

    // add initial metadata, such as tags
    const meta = {};

    if ('tags' in options) {
        if (typeof options.tags === 'string') {
            options.tags = [ options.tags ];
        }

        meta['tags'] = options.tags;
    }

    initialMetadata[params.info_hash] = meta;
}

module.exports = {
    addMagnetLink: (magnetLink, options) => {
        options = options || {};

        const params     = lt.parse_magnet_uri(magnetLink);

        parseOptions(params, options);

        logger.debug(
            'Adding magnet link "%s" to save path "%s"',
            magnetLink,
            params.save_path);

        session.async_add_torrent(params);
    },
    addTorrent: (fileOrBuffer, options) => {
        options = options || {};

        const params = new lt.add_torrent_params();
        params.ti    = new lt.torrent_info(fileOrBuffer);

        parseOptions(params, options);

        logger.debug(
            'Adding torrent "%s" to save path "%s"',
            params.ti.info_hash(),
            params.save_path);

        session.async_add_torrent(params);
    },
    init: async (options) => {
        await init(options);
    },
    load: async (options) => {
        loadOptions = options;

        await loadState(options);
        await loadTorrents(options);

        readAlerts();

        timers.postUpdates = setInterval(() => {
            session.post_dht_stats();
            session.post_session_stats();
            session.post_torrent_updates();
        }, 1000);
    },

    // returns the native libtorrent session, for advanced usage only
    native: () => session,

    // session is an eventemitter?
    off: emitter.off,
    on: emitter.on.bind(emitter),
    once: emitter.once,

    removeTorrent(torrentOrInfoHash) {
        if (typeof torrentOrInfoHash === 'string' && torrents.has(torrentOrInfoHash)) {
            logger.info('Removing torrent %s', torrentOrInfoHash);
            session.remove_torrent(torrents.get(torrentOrInfoHash)._handle);
        } else if (torrentOrInfoHash instanceof Torrent) {
            logger.info('Removing torrent %s', torrentOrInfoHash.infoHash);
            session.remove_torrent(torrentOrInfoHash._handle);
        } else {
            logger.warn('Unknown torrent or info hash: %s', torrentOrInfoHash);
        }
    },

    torrents: () => {
        return torrents.values();
    },
    unload: unload
}
