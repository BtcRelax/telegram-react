/*
 *  Copyright (c) 2018-present, Evgeny Nadymov
 *
 * This source code is licensed under the GPL v.3.0 license found in the
 * LICENSE file in the root directory of this source tree.
 */
import EventEmitter from './EventEmitter';
import LocalConferenceDescription from '../Calls/LocalConferenceDescription';
import StreamManager from '../Calls/StreamManager';
import { canManageVoiceChats, getChatTitle } from '../Utils/Chat';
import { closeGroupCallPanel } from '../Actions/Call';
import { getUserFullName } from '../Utils/User';
import { fromTelegramSource, getStream, getTransport, parseSdp, toTelegramSource } from '../Calls/Utils';
import { showAlert, showLeaveVoiceChatAlert } from '../Actions/Client';
import { throttle } from '../Utils/Common';
import { GROUP_CALL_AMPLITUDE_ANALYSE_INTERVAL_MS, GROUP_CALL_PARTICIPANTS_LOAD_LIMIT } from '../Constants';
import AppStore from './ApplicationStore';
import LStore from './LocalizationStore';
import UserStore from './UserStore';
import TdLibController from '../Controllers/TdLibController';

const JOIN_TRACKS = true;

export function LOG_CALL(str, ...data) {
    // return;
    console.log('[call]' + str, ...data);
}

export function ERROR_CALL(str, ...data) {
    console.error('[call]' + str, ...data);
}

export function LOG_P2P_CALL(str, ...data) {
    // return;
    console.log('[call][p2p]' + str, ...data);
}

export function ERROR_P2P_CALL(str, ...data) {
    console.error('[call][p2p]' + str, ...data);
}

class CallStore extends EventEmitter {
    constructor() {
        super();

        this.reset();

        this.addTdLibListener();

        this.updateGroupCallParticipants = throttle(this.updateGroupCallParticipants, 1000);
    }

    reset = () => {
        this.currentGroupCall = null;
        this.items = new Map();
        this.participants = new Map();
        this.panelOpened = false;
        this.animated = true;
    };

    onUpdate = async update => {
        switch (update['@type']) {
            case 'updateAuthorizationState': {
                const { authorization_state } = update;
                if (!authorization_state) break;

                switch (authorization_state['@type']) {
                    case 'authorizationStateLoggingOut': {
                        const { currentGroupCall } = this;
                        if (currentGroupCall) {
                            const { groupCallId } = currentGroupCall;
                            if (groupCallId) {
                                const groupCall = this.get(groupCallId);
                                if (groupCall && groupCall.is_joined) {
                                    await this.hangUp(groupCallId, false, false);
                                }
                            }
                        }

                        this.reset();
                        break;
                    }
                }

                this.emit('updateAuthorizationState', update);
                break;
            }
            case 'updateCall': {
                LOG_CALL('[update] updateCall', update);
                if (this.p2pCallsEnabled) {
                    const { call } = update;
                    if (call) {
                        const { id, state, is_outgoing } = call;

                        switch (state['@type']) {
                            case 'callStatePending': {
                                if (!is_outgoing) {
                                    this.p2pAcceptCall(id);
                                }
                                break;
                            }
                            case 'callStateReady': {
                                this.p2pSendCallSignalingData(id, 'Hello world!');
                                break;
                            }
                        }
                    }
                }

                this.emit('updateCall', update);
                break;
            }
            case 'updateChatVoiceChat': {
                LOG_CALL('[update] updateChatVoiceChat', update);
                const { chat_id, voice_chat_group_call_id } = update;
                if (AppStore.getChatId() === chat_id && voice_chat_group_call_id) {
                    const groupCall = this.get(voice_chat_group_call_id);
                    if (!groupCall) {
                        TdLibController.send({
                            '@type': 'getGroupCall',
                            group_call_id: voice_chat_group_call_id
                        });
                    }
                }

                this.emit('updateChatVoiceChat', update);
                break;
            }
            case 'updateGroupCall': {
                const { group_call } = update;
                LOG_CALL('[update] updateGroupCall', group_call);
                const prevGroupCall = this.get(group_call.id);

                this.set(group_call);

                const { need_rejoin, is_joined } = group_call;
                const { currentGroupCall } = this;
                if (currentGroupCall && currentGroupCall.groupCallId === group_call.id) {
                    if (need_rejoin) {
                        this.rejoinGroupCall();
                    } else if (prevGroupCall && prevGroupCall.is_joined && !is_joined) {
                        this.hangUp(currentGroupCall.groupCallId);
                    }
                }

                this.emit('updateGroupCall', update);
                break;
            }
            case 'updateGroupCallParticipant': {
                const { group_call_id, participant } = update;

                let participants = this.participants.get(group_call_id);
                if (!participants) {
                    participants = new Map();
                    this.participants.set(group_call_id, participants);
                }

                const { user_id, is_muted_for_all_users, is_muted_for_current_user, order } = participant;
                const isMuted = is_muted_for_all_users || is_muted_for_current_user;
                const prevParticipant = participants.get(user_id);

                participants.set(user_id, participant);

                // mute stream on updateGroupCallParticipant, unmute can be done only on UI user action
                if (user_id === UserStore.getMyId() && isMuted) {
                    const { currentGroupCall } = this;
                    if (currentGroupCall) {
                        const { groupCallId, streamManager } = currentGroupCall;
                        if (group_call_id === groupCallId) {
                            const audioTracks = streamManager.inputStream.getAudioTracks();
                            if (audioTracks.length > 0) {
                                audioTracks[0].enabled = false;
                            }
                        }
                    }
                }

                LOG_CALL('[update] updateGroupCallParticipant', !prevParticipant || prevParticipant.order === '0' && participant.order !== '0' || prevParticipant.order !== '0' && participant.order === '0', prevParticipant, participant);
                // no information before || join group call || leave group call
                if (!prevParticipant || prevParticipant.order === '0' && participant.order !== '0' || prevParticipant.order !== '0' && participant.order === '0') {
                    this.updateGroupCallParticipants(group_call_id);
                }

                this.emit('updateGroupCallParticipant', update);
                break;
            }
            case 'updateNewCallSignalingData': {
                const { data } = update;
                LOG_CALL('[update] updateNewCallSignalingData', update, atob(data));

                this.emit('updateNewCallSignalingData', update);
                break;
            }
            default:
                break;
        }
    };

    onClientUpdate = update => {
        switch (update['@type']) {
            case 'clientUpdateGroupCall': {
                this.currentGroupCall = update.call;

                if (this.panelOpened && !this.currentGroupCall) {
                    closeGroupCallPanel();
                }

                this.emit('clientUpdateGroupCall', update);
                break;
            }
            case 'clientUpdateGroupCallAmplitude': {
                const { amplitudes } = update;

                const { currentGroupCall } = this;
                if (currentGroupCall) {
                    const { isSpeakingMap, groupCallId, meSignSource } = currentGroupCall;

                    for (let i = 0; i < amplitudes.length; i++) {
                        const { type, source, value } = amplitudes[i];

                        let telegramSource = null;
                        switch (type) {
                            case 'input': {
                                telegramSource = toTelegramSource(source);
                                break;
                            }
                            case 'output': {
                                telegramSource = meSignSource;
                                break;
                            }
                        }

                        let params = isSpeakingMap.get(source);
                        if (!params) {
                            params = { isSpeaking: false, speakingTimer: null, cancelSpeakingTimer: null };
                            isSpeakingMap.set(source, params);
                        }

                        const isSpeaking = value > 0.2;
                        if (isSpeaking !== params.isSpeaking) {
                            params.isSpeaking = isSpeaking;
                            if (isSpeaking) {
                                clearTimeout(params.cancelSpeakingTimer);
                                params.speakingTimer = setTimeout(() => {
                                    if (params.isSpeaking) {
                                        TdLibController.send({
                                            '@type': 'setGroupCallParticipantIsSpeaking',
                                            source: toTelegramSource(source),
                                            group_call_id : groupCallId,
                                            is_speaking : true
                                        });
                                    }
                                }, 150);
                            } else {
                                clearTimeout(params.cancelSpeakingTimer);
                                params.cancelSpeakingTimer = setTimeout(() => {
                                    if (!params.isSpeaking) {
                                        TdLibController.send({
                                            '@type': 'setGroupCallParticipantIsSpeaking',
                                            source: toTelegramSource(source),
                                            group_call_id: groupCallId,
                                            is_speaking: false
                                        });
                                    }
                                }, 1000);
                            }
                        }
                    }
                }

                this.emit('clientUpdateGroupCallAmplitude', update);
                break;
            }
            case 'clientUpdateGroupCallConnectionState': {
                this.emit('clientUpdateGroupCallConnectionState', update);
                break;
            }
            case 'clientUpdateGroupCallPanel': {
                this.panelOpened = update.opened;
                this.emit('clientUpdateGroupCallPanel', update);
                break;
            }
            default:
                break;
        }
    };

    addTdLibListener = () => {
        TdLibController.on('update', this.onUpdate);
        TdLibController.on('clientUpdate', this.onClientUpdate);
    };

    removeTdLibListener = () => {
        TdLibController.off('update', this.onUpdate);
        TdLibController.off('clientUpdate', this.onClientUpdate);
    };

    assign(source1, source2) {
        this.set(Object.assign({}, source1, source2));
    }

    get(callId) {
        return this.items.get(callId);
    }

    set(call) {
        this.items.set(call.id, call);
    }

    playSound(sound) {
        try {
            this.audio = this.audio || new Audio();
            const { audio } = this;

            audio.src = sound;
            audio.play();
        } catch (e) {
            ERROR_CALL('playSound', sound, e);
        }
    }

    startConnectingSound(connection) {
        this.stopConnectingSound(null);

        setTimeout(() => {
            const { currentGroupCall } = this;
            if (currentGroupCall && currentGroupCall.connection === connection && (connection.iceConnectionState === 'checking' || connection.iceConnectionState === 'new')) {
                const audio = new Audio('sounds/group_call_connect.mp3');
                audio.loop = true;
                audio.connection = connection;

                this.connectionAudio = audio;

                audio.play();
            }
        }, 2500);
    }

    stopConnectingSound(connection) {
        const { connectionAudio } = this;
        if (!connectionAudio) return;
        if (connection && connectionAudio.connection !== connection) return;

        this.connectionAudio = null;
        connectionAudio.pause();
    }

    async updateGroupCallParticipants(groupCallId) {
        LOG_CALL(`updateGroupCallParticipants id=${groupCallId}`);
        const { currentGroupCall } = this;
        if (!currentGroupCall) return;
        if (currentGroupCall.groupCallId !== groupCallId) return;

        const { transport, meSignSource, connection, description, handleUpdateGroupCallParticipants } = currentGroupCall;
        if (!handleUpdateGroupCallParticipants) return;
        if (!transport) return;
        if (!meSignSource) return;
        if (!description) return;

        if (currentGroupCall.updatingSdp) {
            LOG_CALL(`updateGroupCallParticipants id=${groupCallId} cancel`, currentGroupCall.updatingSdp);
            return
        }

        const ts = new Date().getMilliseconds();

        try {
            LOG_CALL(`updateGroupCallParticipants id=${groupCallId} updateSdp start`, ts);
            currentGroupCall.updatingSdp = true;

            let participants = Array.from(this.participants.get(groupCallId).values()).filter(x => x.order !== '0');
            if (!participants.some(x => x.user_id === UserStore.getMyId())) {
                participants = [{ '@type': 'groupCallParticipantMe', source: currentGroupCall.meSignSource, user_id: UserStore.getMyId() }, ...participants];
            }
            const ssrcs = participants.map(x => ({
                ssrc: fromTelegramSource(x.source),
                isMain: x.source === currentGroupCall.meSignSource,
                name: getUserFullName(x.user_id),
                userId: x.user_id
            }));
            LOG_CALL(`updateGroupCallParticipants id=${groupCallId} ssrcs`, participants, ssrcs);
            const data = {
                transport,
                ssrcs
            };

            description.updateFromServer(data);
            const sdp = description.generateSdp();

            LOG_CALL(`[conn][updateGroupCallParticipants] setRemoteDescription participantsCount=${participants.length} signaling=${connection.signalingState} ice=${connection.iceConnectionState} gathering=${connection.iceGatheringState} connection=${connection.connectionState}`, sdp);
            await connection.setRemoteDescription({
                type: 'offer',
                sdp,
            });

            LOG_CALL(`[conn][updateGroupCallParticipants] createAnswer id=${groupCallId}`, ts);
            const answer = await connection.createAnswer();
            LOG_CALL(`[conn][updateGroupCallParticipants] setLocalDescription id=${groupCallId}`, ts);
            await connection.setLocalDescription(answer);
        } finally {
            LOG_CALL(`updateGroupCallParticipants id=${groupCallId} updateSdp finish`, ts);
            currentGroupCall.updatingSdp = false;
        }
    }

    async startGroupCall(chatId) {
        let { currentGroupCall } = this;
        LOG_CALL('startGroupCall', currentGroupCall);
        if (currentGroupCall) {
            const { chatId: oldChatId } = currentGroupCall;

            showAlert({
                title: LStore.getString('VoipOngoingChatAlertTitle'),
                message: LStore.replaceTags(LStore.formatString('VoipOngoingChatAlert', getChatTitle(oldChatId), getChatTitle(chatId))),
                ok: LStore.getString('OK'),
                cancel: LStore.getString('Cancel'),
                onResult: async result => {
                    if (result) {
                        currentGroupCall = this.currentGroupCall;
                        if (currentGroupCall) {
                            await this.hangUp(currentGroupCall.groupCallId);
                        }
                        await this.startGroupCallInternal(chatId);
                    }
                }
            });

            return;
        }

        await this.startGroupCallInternal(chatId);
    }

    async startGroupCallInternal(chatId) {
        LOG_CALL('[tdweb] createVoiceChat', chatId);
        const groupCallId = await TdLibController.send({
            '@type': 'createVoiceChat',
            chat_id: chatId
        });
        LOG_CALL('[tdweb] createVoiceChat result', groupCallId);
    }

    async joinGroupCall(chatId, groupCallId, muted = true, rejoin = false) {
        if (!this.audio) {
            this.audio = new Audio()
            this.audio.play();
        }

        LOG_CALL(`joinGroupCall chatId=${chatId} id=${groupCallId} muted=${muted} rejoin=${rejoin}`);
        const groupCall = this.get(groupCallId);
        if (!groupCall) {
            LOG_CALL('[tdweb] getGroupCall id=' + groupCallId);
            TdLibController.send({ '@type': 'getGroupCall', group_call_id: groupCallId });
        }

        let { currentGroupCall } = this;
        let streamManager = null;
        try {
            if (rejoin) {
                streamManager = currentGroupCall.streamManager;
            } else {
                const constraints = {
                    audio: true,
                    video: false
                };
                const stream = await getStream(constraints, muted);

                streamManager = new StreamManager(GROUP_CALL_AMPLITUDE_ANALYSE_INTERVAL_MS);
                streamManager.addTrack(stream, 'input');
            }
        } catch (e) {
            ERROR_CALL('joinGroupCall getStream error', e);
            showAlert({
                title: LStore.getString('AppName'),
                message: LStore.getString('VoipNeedMicPermission'),
                ok: LStore.getString('OK')
            });
        }
        if (!streamManager || !streamManager.inputStream) return;

        LOG_CALL('joinGroupCall has another', groupCallId, currentGroupCall);
        if (currentGroupCall && !rejoin) {
            const { chatId: oldChatId } = currentGroupCall;

            showAlert({
                title: LStore.getString('VoipOngoingChatAlertTitle'),
                message: LStore.replaceTags(LStore.formatString('VoipOngoingChatAlert', getChatTitle(oldChatId), getChatTitle(chatId))),
                ok: LStore.getString('OK'),
                cancel: LStore.getString('Cancel'),
                onResult: async result => {
                    if (result) {
                        currentGroupCall = this.currentGroupCall;
                        if (currentGroupCall) {
                            this.hangUp(currentGroupCall.groupCallId);
                        }
                        this.joinGroupCallInternal(chatId, groupCallId, streamManager, muted, rejoin);
                    }
                }
            });

            return;
        }

        await this.joinGroupCallInternal(chatId, groupCallId, streamManager, muted, rejoin);
    }

    setCurrentGroupCall(call) {
        TdLibController.clientUpdate({
            '@type': 'clientUpdateGroupCall',
            call
        });
    }

    async rejoinGroupCall() {
        const { currentGroupCall } = this;
        LOG_CALL('rejoinGroupCall', currentGroupCall);
        if (!currentGroupCall) return;

        const { chatId, groupCallId } = currentGroupCall;

        this.hangUp(groupCallId, false, true);
        this.joinGroupCall(chatId, groupCallId, this.isMuted(), true);
    }

    async joinGroupCallInternal(chatId, groupCallId, streamManager, muted, rejoin = false) {
        LOG_CALL('joinGroupCallInternal start', groupCallId);
        LOG_CALL('[conn] ctor');

        const connection = new RTCPeerConnection(null);
        connection.ontrack = event => {
            LOG_CALL('[conn] ontrack', event);
            this.onTrack(event);
        };
        connection.onsignalingstatechange = event => {
            LOG_CALL('[conn] onsignalingstatechange', connection.signalingState);
        };
        connection.onconnectionstatechange = event => {
            LOG_CALL('[conn] onconnectionstatechange', connection.connectionState);
        };
        connection.onnegotiationneeded = event => {
            LOG_CALL('[conn] onnegotiationneeded', connection.signalingState);
            this.startNegotiation(muted, rejoin);
        };
        connection.onicecandidate = event => {
            LOG_CALL('[conn] onicecandidate', event);
        };
        connection.oniceconnectionstatechange = event => {
            LOG_CALL(`[conn] oniceconnectionstatechange = ${connection.iceConnectionState}`);

            TdLibController.clientUpdate({
                '@type': 'clientUpdateGroupCallConnectionState',
                state: connection.iceConnectionState,
                groupCallId
            });

            if (connection.iceConnectionState !== 'checking') {
                this.stopConnectingSound(connection);
            }

            switch (connection.iceConnectionState) {
                case 'checking': {
                    break;
                }
                case 'closed': {
                    this.hangUp(groupCallId);
                    break;
                }
                case 'completed': {
                    break;
                }
                case 'connected': {
                    const { currentGroupCall } = this;
                    if (currentGroupCall && currentGroupCall.connection === connection && !currentGroupCall.joined) {
                        currentGroupCall.joined = true;
                        this.playSound('sounds/group_call_start.mp3');
                    }
                    break;
                }
                case 'disconnected': {
                    break;
                }
                case 'failed': {
                    //TODO: replace with ICE restart
                    this.hangUp(groupCallId);
                    // connection.restartIce();
                    break;
                }
                case 'new': {
                    break;
                }
            }
        };
        connection.ondatachannel = event => {
            LOG_CALL(`[conn] ondatachannel`);
        };

        if (streamManager.inputStream) {
            streamManager.inputStream.getTracks().forEach(track => {
                LOG_CALL('[conn] addTrack', track);
                connection.addTrack(track, streamManager.inputStream);
            });
        }

        let { currentGroupCall } = this;
        if (currentGroupCall && rejoin) {
            currentGroupCall.connection = connection;
            currentGroupCall.handleUpdateGroupCallParticipants = false;
            currentGroupCall.updatingSdp = false;
            LOG_CALL('joinGroupCallInternal update currentGroupCall', groupCallId, currentGroupCall);
        } else {
            currentGroupCall = {
                chatId,
                groupCallId,
                connection,
                handleUpdateGroupCallParticipants: false,
                updatingSdp: false,
                streamManager,
                isSpeakingMap: new Map()
            }
            this.setCurrentGroupCall(currentGroupCall);
            LOG_CALL('joinGroupCallInternal set currentGroupCall', groupCallId, currentGroupCall);
        }
    }

    startNegotiation = async (isMuted, rejoin) => {
        const { currentGroupCall } = this;
        if (!currentGroupCall) return;

        const { connection, groupCallId, streamManager } = currentGroupCall;
        if (!connection) return;

        const offerOptions = {
            offerToReceiveAudio: 1,
            offerToReceiveVideo: 0,
        };
        let offer = await connection.createOffer(offerOptions);
        LOG_CALL('[conn][joinGroupCallInternal] setLocalDescription', offer);
        await connection.setLocalDescription(offer);
        let clientInfo = parseSdp(offer.sdp);
        let { ufrag, pwd, hash, setup, fingerprint, source } = clientInfo;
        LOG_CALL('[conn][joinGroupCallInternal] clientInfo', clientInfo);


        offer = await connection.createOffer(offerOptions);
        LOG_CALL('[conn][joinGroupCallInternal] setLocalDescription', offer);
        await connection.setLocalDescription(offer);
        clientInfo = parseSdp(offer.sdp);
        LOG_CALL('[conn][joinGroupCallInternal] clientInfo', clientInfo);

        currentGroupCall.meSignSource = toTelegramSource(source);

        if (!rejoin) {
            this.startConnectingSound(connection);
        }

        // this.participants.set(currentGroupCall.groupCallId, new Map());
        const request = {
            '@type': 'joinGroupCall',
            group_call_id: groupCallId,
            payload: {
                '@type': 'groupCallPayload',
                ufrag,
                pwd,
                fingerprints: [{ '@type': 'groupCallPayloadFingerprint', hash, setup: 'active', fingerprint }]
            },
            source: currentGroupCall.meSignSource,
            is_muted: isMuted
        };

        let result = null;
        try {
            LOG_CALL(`[tdweb] joinGroupCall id=${groupCallId}`, request);
            result = await TdLibController.send(request);
            LOG_CALL('[tdweb] joinGroupCall result', result);
        } catch (e) {
            ERROR_CALL('[tdweb] joinGroupCall error', e);
        }

        if (!result) {
            LOG_CALL('joinGroupCallInternal abort 0');
            this.closeConnectionAndStream(connection, streamManager);
            return;
        }

        const transport = getTransport(result);
        this.currentGroupCall.transport = transport;

        if (connection.iceConnectionState !== 'new') {
            LOG_CALL(`joinGroupCallInternal abort 1 connectionState=${connection.iceConnectionState}`);
            this.closeConnectionAndStream(connection, streamManager);
            return;
        }
        if (this.currentGroupCall !== currentGroupCall) {
            LOG_CALL('joinGroupCallInternal abort 2', this.currentGroupCall, currentGroupCall);
            this.closeConnectionAndStream(connection, streamManager);
            return;
        }
        if (currentGroupCall.connection !== connection) {
            LOG_CALL('joinGroupCallInternal abort 3');
            this.closeConnectionAndStream(connection, streamManager);
            return;
        }

        const description = new LocalConferenceDescription();
        description.onSsrcs = () => { };

        currentGroupCall.description = description

        LOG_CALL(`[tdweb] loadGroupCallParticipants limit=${GROUP_CALL_PARTICIPANTS_LOAD_LIMIT}`);
        const r1 = await TdLibController.send({
            '@type': 'loadGroupCallParticipants',
            group_call_id: groupCallId,
            limit: GROUP_CALL_PARTICIPANTS_LOAD_LIMIT
        });
        LOG_CALL(`[tdweb] loadGroupCallParticipants result`, r1);

        LOG_CALL(`[tdweb] loadGroupCallParticipants limit=${GROUP_CALL_PARTICIPANTS_LOAD_LIMIT}`);
        const r2 = await TdLibController.send({
            '@type': 'loadGroupCallParticipants',
            group_call_id: groupCallId,
            limit: GROUP_CALL_PARTICIPANTS_LOAD_LIMIT
        });
        LOG_CALL(`[tdweb] loadGroupCallParticipants result`, r2);

        let meParticipant = null;
        const participants = this.participants.get(groupCallId);
        if (participants) {
            meParticipant = participants.get(UserStore.getMyId());
        }

        if (meParticipant && meParticipant.source !== currentGroupCall.meSignSource) {
            LOG_CALL('[fix] meParticipant', meParticipant.source, currentGroupCall.meSignSource);
            meParticipant = { ...meParticipant, ...{ source: currentGroupCall.meSignSource } };
            this.participants.get(groupCallId).set(UserStore.getMyId(), meParticipant);
        }

        if (!meParticipant) {
            meParticipant = {
                '@type': 'groupCallParticipantMe',
                user_id: UserStore.getMyId(),
                source: currentGroupCall.meSignSource,
                can_be_muted: true,
                can_be_unmuted: true,
                can_unmute_self: true,
                is_muted_for_all_users: true,
                is_muted_for_current_user: false,
                is_speaking: false,
                order: Number
            };
        }

        const data1 = {
            transport,
            ssrcs: [{
                ssrc: fromTelegramSource(meParticipant.source),
                isMain: true,
                name: getUserFullName(meParticipant.user_id),
                user_id: meParticipant.user_id
            }]
        };

        description.updateFromServer(data1);
        const sdp1 = description.generateSdp(true);

        LOG_CALL(`[conn][joinGroupCallInternal] setRemoteDescription signaling=${connection.signalingState} ice=${connection.iceConnectionState} gathering=${connection.iceGatheringState} connection=${connection.connectionState}`, sdp1);
        await connection.setRemoteDescription({
            type: 'answer',
            sdp: sdp1,
        });

        // setTimeout(async () => {
        currentGroupCall.handleUpdateGroupCallParticipants = true;
        await this.updateGroupCallParticipants(groupCallId);
        // }, 2500);

        // const data2 = {
        //     transport,
        //     ssrcs: participants.map(x => ({
        //         ssrc: x.source >>> 0,
        //         isMain: x.source === currentGroupCall.meSignSource,
        //         name: getUserFullName(x.user_id)
        //     }))
        // };
        //
        // description.updateFromServer(data2);
        // const sdp2 = description.generateSdp();
        //
        // await connection.setRemoteDescription({
        //     type: 'offer',
        //     sdp: sdp2,
        // });
        // const answer = await connection.createAnswer();
        // await connection.setLocalDescription(answer);

        LOG_CALL('joinGroupCallInternal stop', groupCallId);
    }

    async hangUp(groupCallId, discard = false, rejoin = false) {
        LOG_CALL(`hangUp start id=${groupCallId} discard=${discard} rejoin=${rejoin}`);
        const { currentGroupCall } = this;
        if (!currentGroupCall) return;
        if (currentGroupCall.groupCallId !== groupCallId) return;

        const { connection, streamManager } = currentGroupCall;
        if (!rejoin) {
            this.setCurrentGroupCall(null);
            this.stopConnectingSound(null);
        }

        this.closeConnectionAndStream(connection, rejoin ? null : streamManager);

        if (JOIN_TRACKS) {
            document.getElementById('group-call-player').innerHTML = '';
        } else {
            document.getElementById('players').innerHTML = '';
        }

        if (!rejoin) {
            if (discard) {
                LOG_CALL(`[tdweb] discardGroupCall id=${groupCallId}`);
                await TdLibController.send({
                    '@type': 'discardGroupCall',
                    group_call_id: groupCallId
                });
                return;
            }

            const groupCall = this.get(groupCallId);
            if (groupCall && groupCall.is_joined) {
                LOG_CALL(`[tdweb] leaveGroupCall id=${groupCallId}`);
                await TdLibController.send({
                    '@type': 'leaveGroupCall',
                    group_call_id: groupCallId
                });
                return;
            }

            LOG_CALL(`[tdweb] id=${groupCallId} payload=null`);
            await TdLibController.send({
                '@type': 'joinGroupCall',
                group_call_id: groupCallId,
                payload: null
            });
        }
    }

    closeConnectionAndStream(connection, streamManager) {
        try {
            if (connection) {
                LOG_CALL('[conn][closeConnectionAndStream] close');
                connection.close();
            }
        } catch (e) {
            LOG_CALL('hangUp error 1', e);
        }

        try {
            if (streamManager) {
                streamManager.inputStream.getTracks().forEach(t => {
                    t.stop();
                    streamManager.removeTrack(t);
                });
            }
        } catch (e) {
            LOG_CALL('hangUp error 2', e);
        }

        try {
            if (streamManager) {
                streamManager.outputStream.getTracks().forEach(t => {
                    t.stop();
                    streamManager.removeTrack(t);
                });
            }
        } catch (e) {
            LOG_CALL('hangUp error 3', e);
        }
    }

    async leaveGroupCall(chatId, groupCallId, forceDiscard = false) {
        LOG_CALL('leaveGroupCall', chatId, groupCallId);
        const manageVoiceCalls = canManageVoiceChats(chatId);
        if (manageVoiceCalls) {
            if (forceDiscard) {
                this.playSound('sounds/group_call_end.mp3');
                await this.hangUp(groupCallId, true);
                return;
            }

            showLeaveVoiceChatAlert({
                onResult: async result => {
                    LOG_CALL('leaveGroupCall result', result);
                    if (!result) return;

                    this.playSound('sounds/group_call_end.mp3');
                    await this.hangUp(groupCallId, result.discard);
                }
            });
            return;
        }

        this.playSound('sounds/group_call_end.mp3');
        await this.hangUp(groupCallId);
    }

    removeTrack(track, streamManager, endpoint, stream) {
        if (JOIN_TRACKS) {
            streamManager.removeTrack(track);

            const player = document.getElementById('group-call-player');
            if (!player) return;

            const tags = player.getElementsByTagName('audio');
            const audio = tags.length > 0 ? tags[0] : null;
            if (!audio) return;

            audio.srcObject = streamManager.outputStream;
        } else {
            const players = document.getElementById('players');
            if (!players) return;

            for (let audio of players.getElementsByTagName('audio')) {
                if (audio.e === endpoint && audio.srcObject === stream) {
                    players.removeChild(audio);
                    break;
                }
            }
        }
    }

    tryAddTrack(event) {
        const { streams, track } = event;

        const stream = streams[0];
        const endpoint = stream.id.substring(6);
        track.e = endpoint;

        if (JOIN_TRACKS) {
            if (!track) return;

            const { currentGroupCall } = this;
            if (!currentGroupCall) return;

            const { streamManager, meSignSource } = currentGroupCall;
            if (!streamManager) return;

            const player = document.getElementById('group-call-player');
            if (!player) return;

            const tags = player.getElementsByTagName('audio');
            let audio = tags.length > 0 ? tags[0] : null;

            track.onended = () => {
                LOG_CALL('[track] onended');
                this.removeTrack(track, streamManager, endpoint, stream);
            }

            streamManager.addTrack(stream, 'output');

            if (!audio) {
                audio = document.createElement('audio');
                audio.e = endpoint;
                audio.autoplay = true;
                audio.srcObject = streamManager.outputStream;
                audio.volume = 1.0;
                if (typeof audio.sinkId !== 'undefined') {
                    const { outputDeviceId } = currentGroupCall;
                    if (outputDeviceId) {
                        audio.setSinkId(outputDeviceId);
                    }
                }

                player.appendChild(audio);
                // audio.play();
            } else {
                audio.srcObject = streamManager.outputStream;
            }
        } else {
            const players = document.getElementById('players');
            if (!players) return;

            if (track) {
                track.onended = () => {
                    LOG_CALL('conn.track.onended');
                    this.removeTrack(track, null, endpoint, stream);
                }
            }

            let handled;
            for (let audio of players.getElementsByTagName('audio')) {
                if (audio.e === endpoint) {
                    audio.srcObject = stream;
                    handled = true;
                    break;
                }
            }

            if (!handled) {
                const audio = document.createElement('audio');
                audio.e = endpoint;
                audio.autoplay = true;
                audio.srcObject = stream;
                audio.volume = 1.0;

                const { currentGroupCall } = this;
                if (currentGroupCall) {
                    const participants = this.participants.get(currentGroupCall.groupCallId);
                    if (participants) {
                        const participant = Array.from(participants.values()).find(x => x.source === toTelegramSource(Number.parseInt(endpoint, 10)));
                        if (participant) {
                            audio.dataset.userId = participant.user_id;
                        }
                    }

                    if (typeof audio.sinkId !== 'undefined') {
                        const { outputDeviceId } = currentGroupCall;
                        if (outputDeviceId) {
                            audio.setSinkId(outputDeviceId);
                        }
                    }
                }
                audio.dataset.source = endpoint;

                players.appendChild(audio);
                audio.play();
            }
        }
    }

    replaceOutputDevice(deviceId) {
        if (JOIN_TRACKS) {
            const player = document.getElementById('group-call-player');
            if (!player) return;

            for (let audio of player.getElementsByTagName('audio')) {
                if (typeof audio.sinkId !== 'undefined') {
                    audio.setSinkId(deviceId);
                }
            }
        } else {
            const players = document.getElementById('players');
            if (!players) return;

            for (let audio of players.getElementsByTagName('audio')) {
                if (typeof audio.sinkId !== 'undefined') {
                    audio.setSinkId(deviceId);
                }
            }
        }
    }

    setOutputDeviceId(deviceId) {
        const { currentGroupCall } = this;
        if (!currentGroupCall) return;

        currentGroupCall.outputDeviceId = deviceId;

        this.replaceOutputDevice(deviceId);
    }

    getOutputDeviceId() {
        const { currentGroupCall } = this;
        if (!currentGroupCall) return null;

        if (JOIN_TRACKS) {
            const player = document.getElementById('group-call-player');
            if (!player) return null;

            for (let audio of player.getElementsByTagName('audio')) {
                if (typeof audio.sinkId !== 'undefined') {
                    return audio.sinkId;
                }
            }
        } else {
            const players = document.getElementById('players');
            if (!players) return null;

            for (let audio of players.getElementsByTagName('audio')) {
                if (typeof audio.sinkId !== 'undefined') {
                    return audio.sinkId;
                }
            }
        }

        return null;
    }

    async replaceInputAudioDevice(stream) {
        const { currentGroupCall } = this;
        if (!currentGroupCall) return;

        const { connection, streamManager } = currentGroupCall;
        if (!connection) return;

        const { inputStream } = streamManager;

        // const videoTrack = stream.getVideoTracks()[0];
        // const sender = pc.getSenders().find(function(s) {
        //     return s.track.kind == videoTrack.kind;
        // });
        // sender.replaceTrack(videoTrack);

        const audioTrack = stream.getAudioTracks()[0];
        const sender2 = connection.getSenders().find(x => {
            return x.track.kind === audioTrack.kind;
        });
        const oldTrack = sender2.track;
        await sender2.replaceTrack(audioTrack);

        oldTrack.stop();
        streamManager.replaceInputAudio(stream, oldTrack);
    }

    async setInputAudioDeviceId(deviceId, stream) {
        const { currentGroupCall } = this;
        if (!currentGroupCall) return;

        await this.replaceInputAudioDevice(stream);
    }

    getInputAudioDeviceId() {
        const { currentGroupCall } = this;
        if (!currentGroupCall) return null;

        const { connection } = currentGroupCall;
        if (!connection) return null;

        let deviceId = null
        connection.getSenders().forEach(s => {
            const { track } = s;
            if (track && track.kind === 'audio') {
                const settings = track.getSettings();
                if (settings) {
                    deviceId = settings.deviceId;
                }
            }
        });

        return deviceId;
    }

    getInputVideoDeviceId() {
        const { currentGroupCall } = this;
        if (!currentGroupCall) return null;

        const { connection } = currentGroupCall;
        if (!connection) return null;

        let deviceId = null
        connection.getSenders().forEach(s => {
            const { track } = s;
            if (track && track.kind === 'video') {
                const settings = track.getSettings();
                if (settings) {
                    deviceId = settings.deviceId;
                }
            }
        });

        return deviceId;
    }

    onTrack(event) {
        this.tryAddTrack(event);
    }

    isMuted() {
        const { currentGroupCall } = this;
        if (!currentGroupCall) return true;

        const { groupCallId, streamManager } = currentGroupCall;
        if (!streamManager) return true;

        const audioTracks = streamManager.inputStream.getAudioTracks();
        if (audioTracks.length > 0) {
            return !audioTracks[0].enabled;
        }

        return true;
    }

    changeMuted(muted) {
        const { currentGroupCall } = this;
        if (!currentGroupCall) return;

        const { groupCallId, streamManager } = currentGroupCall;
        if (!streamManager) return;

        const audioTracks = streamManager.inputStream.getAudioTracks();
        if (audioTracks.length > 0) {
            audioTracks[0].enabled = !muted;
        }

        LOG_CALL(`[tdweb] toggleGroupCallParticipantIsMuted id=${groupCallId} user_id=${UserStore.getMyId()} is_muted=${muted}`, this.get(groupCallId));
        TdLibController.send({
            '@type': 'toggleGroupCallParticipantIsMuted',
            group_call_id: groupCallId,
            user_id: UserStore.getMyId(),
            is_muted: muted
        });
    }

    changeUserMuted(userId, muted) {
        const { currentGroupCall } = this;
        if (!currentGroupCall) return;

        const { groupCallId, connection } = currentGroupCall;
        if (!connection) return;

        if (UserStore.getMyId() === userId) {
            connection.getSenders().forEach(s => {
                const { track } = s;
                if (track && track.kind === 'audio') {
                    track.enabled = !muted;
                }
            });
        }

        LOG_CALL(`[tdweb] toggleGroupCallParticipantIsMuted id=${groupCallId} user_id=${UserStore.getMyId()} is_muted=${muted}`, this.get(groupCallId));
        TdLibController.send({
            '@type': 'toggleGroupCallParticipantIsMuted',
            group_call_id: groupCallId,
            user_id: userId,
            is_muted: muted
        });
    }

    toggleMuteNewParticipants(groupCallId, mute) {
        const { currentGroupCall } = this;
        if (!currentGroupCall) return;

        const { groupCallId: currentGroupCallId } = currentGroupCall;
        if (groupCallId !== currentGroupCallId) return;

        LOG_CALL('toggleMuteNewParticipants', groupCallId, mute);
        TdLibController.send({
            '@type': 'toggleGroupCallMuteNewParticipants',
            group_call_id: groupCallId,
            mute_new_participants: mute
        });
    }

    setGroupCallParticipantVolumeLevel(groupCallId, userId, volume) {
        const { currentGroupCall } = this;
        if (!currentGroupCall) return;

        const { groupCallId: currentGroupCallId } = currentGroupCall;
        if (groupCallId !== currentGroupCallId) return;

        LOG_CALL('setGroupCallParticipantVolumeLevel', groupCallId, userId, volume);
        TdLibController.send({
            '@type': 'setGroupCallParticipantVolumeLevel',
            group_call_id: groupCallId,
            user_id: userId,
            volume_level: volume
        });
    }

    get p2pCallsEnabled() {
        return TdLibController.calls;
    }

    p2pGetProtocol() {
        return {
            '@type': 'callProtocol',
            udp_p2p: true,
            udp_reflector: true,
            min_layer: 126,
            max_layer: 126,
            library_versions: []
        };
    }

    p2pStartCall(userId, isVideo) {
        LOG_P2P_CALL('p2pStartCall', userId, isVideo);

        const protocol = this.p2pGetProtocol();
        LOG_P2P_CALL('[tdlib] createCall', userId, protocol, isVideo);
        TdLibController.send({
            '@type': 'createCall',
            user_id: userId,
            protocol,
            is_video: isVideo
        });
    }

    p2pAcceptCall(callId) {
        LOG_P2P_CALL('p2pAcceptCall', callId);

        const protocol = this.p2pGetProtocol();
        LOG_P2P_CALL('[tdlib] acceptCall', callId, protocol);
        TdLibController.send({
            '@type': 'acceptCall',
            call_id: callId,
            protocol
        });
    }

    p2pDiscardCall(callId, isDisconnected, duration, isVideo, connectionId) {
        LOG_P2P_CALL('p2pDiscardCall', callId);

        LOG_P2P_CALL('[tdlib] discardCall', callId, isDisconnected, duration, isVideo, connectionId);
        TdLibController.send({
            '@type': 'discardCall',
            call_id: callId,
            is_disconnected: isDisconnected,
            duration,
            is_video: isVideo,
            connection_id: connectionId
        });
    }

    p2pSendCallSignalingData(callId, data) {
        LOG_P2P_CALL('p2pSendCallSignalingData', callId, data);

        LOG_P2P_CALL('[tdlib] sendCallSignalingData', callId, data);
        TdLibController.send({
            '@type': 'sendCallSignalingData',
            call_id: callId,
            data: btoa(data)
        });
    }
}

const store = new CallStore();
window.call = store;
export default store;
