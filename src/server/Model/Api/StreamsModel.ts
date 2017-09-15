import ApiModel from './ApiModel';
import * as apid from '../../../../api';
import { StreamManagerInterface } from '../../Service/Stream/StreamManager';
import { Stream } from '../../Service/Stream/Stream';
import { MpegTsLiveStream } from '../../Service/Stream/MpegTsLiveStream';
import { RecordedHLSStream } from '../../Service/Stream/RecordedHLSStream';
import { ProgramsDBInterface } from '../DB/ProgramsDB';
import { ServicesDBInterface } from '../DB/ServicesDB';
import { RecordedDBInterface } from '../DB/RecordedDB';
import { PLayList } from './PlayListInterface';

interface StreamModelInfo {
    stream: Stream;
    streamNumber: number;
}

namespace StreamsModelInterface {
    export const channleIsNotFoundError = 'channelIsNotDound';
}

interface StreamsModelInterface extends ApiModel {
    getLiveMpegTs(channelId: apid.ServiceItemId, mode: number): Promise<StreamModelInfo>;
    getRecordedHLS(recordedId: apid.RecordedId, mode: number, encodedId: apid.EncodedId | null): Promise<number>;
    stop(streamNumber: number): Promise<void>;
    forcedStopAll(): Promise<void>;
    getInfos(): any;
    getLiveM3u8(host: string, isSecure: boolean, channelId: apid.ServiceItemId, mode: number): Promise<PLayList>;
}

class StreamsModel extends ApiModel implements StreamsModelInterface {
    private createMpegTsLiveStream: (channelId: apid.ServiceItemId, mode: number) => MpegTsLiveStream;
    private createRecordedHLSStream: (recordedId: apid.RecordedId, mode: number, encodedId: apid.EncodedId | null) => RecordedHLSStream;
    private streamManager: StreamManagerInterface;
    private programDB: ProgramsDBInterface;
    private servicesDB: ServicesDBInterface;
    private recordedDB: RecordedDBInterface;

    constructor(
        streamManager: StreamManagerInterface,
        createMpegTsLiveStream: (channelId: apid.ServiceItemId, mode: number) => MpegTsLiveStream,
        createRecordedHLSStream: (recordedId: apid.RecordedId, mode: number, encodedId: apid.EncodedId | null) => RecordedHLSStream,
        programDB: ProgramsDBInterface,
        servicesDB: ServicesDBInterface,
        recordedDB: RecordedDBInterface,
    ) {
        super();
        this.streamManager = streamManager;
        this.createMpegTsLiveStream = createMpegTsLiveStream;
        this.createRecordedHLSStream = createRecordedHLSStream;
        this.programDB = programDB;
        this.servicesDB = servicesDB;
        this.recordedDB = recordedDB;
    }

    /**
    * ライブ視聴
    * @param channelId: channel id
    * @param mode: config.MpegTsStreaming の index 番号
    * @return Promise<StreamModelInfo>
    */
    public async getLiveMpegTs(channelId: apid.ServiceItemId, mode: number): Promise<StreamModelInfo> {
        // 同じパラメータの stream がないか確認する
        let infos = this.streamManager.getStreamInfos();
        for(let info of infos) {
            if(info.type === 'MpegTsLive' && info.channelId === channelId && info.mode === mode) {
                return {
                    stream: this.streamManager.getStream(info.streamNumber)!,
                    streamNumber: info.streamNumber,
                }
            }
        }

        let stream = this.createMpegTsLiveStream(channelId, mode);
        let streamNumber = await this.streamManager.start(stream);

        let result = this.streamManager.getStream(streamNumber);
        if(result === null) { throw new Error('CreateStreamError'); }

        let encChild = result.getEncChild();
        if(encChild !== null) {
            encChild.stderr.on('data', (data) => {
                this.log.stream.debug(String(data));
            });
        }

        return { stream: result, streamNumber: streamNumber };
    }

    /**
    * 録画済みファイル HLS 配信
    * @param recordedId: recorded id
    * @param mode: config.recordedHLS の index 番号
    * @param encodedId: encodedId | null
    * @return Promise<number> stream number
    */
    public async getRecordedHLS(recordedId: apid.RecordedId, mode: number, encodedId: apid.EncodedId | null): Promise<number> {
        let stream = this.createRecordedHLSStream(recordedId, mode, encodedId);
        let streamNumber = await this.streamManager.start(stream);

        return streamNumber;
    }

    /**
    * stop stream
    */
    public stop(streamNumber: number): Promise<void> {
        return this.streamManager.stop(streamNumber);
    }

    /**
    * すべてのストリームを強制停止
    */
    public forcedStopAll(): Promise<void> {
        return this.streamManager.forcedStopAll();
    }

    /**
    * ストリーム情報を取得
    */
    public async getInfos(): Promise<{ [key: string]: any }[]> {
        let infos: { [key: string]: any }[] = this.streamManager.getStreamInfos();

        for(let info of infos) {
            if(typeof info.type === 'undefined') { continue; }
            if(info.type === 'MpegTsLive' && typeof info.channelId !== 'undefined') {
                let channel = await this.servicesDB.findId(info.channelId);
                let program = await this.programDB.findBroadcastingChanel(info.channelId);

                if(channel.length > 0) {
                    info.channelName = channel[0].name;
                }

                if(program.length > 0) {
                    info.title = program[0].name;
                    info.startAt = program[0].startAt;
                    info.endAt = program[0].endAt;
                    info.channelType = program[0].channelType;
                    if(program[0].description !== null) { info.description = program[0].description; }
                    if(program[0].extended !== null) { info.extended = program[0].extended; }
                }
            }

            if(info.type === 'RecordedHLS' && typeof info.recordedId !== 'undefined') {
                let recorded = await this.recordedDB.findId(info.recordedId);

                if(recorded.length > 0) {
                    let channel = await this.servicesDB.findId(recorded[0].channelId);
                    info.channelName = channel.length > 0 ? channel[0].name : String(recorded[0].channelId);

                    info.title = recorded[0].name;
                    info.startAt = recorded[0].startAt;
                    info.endAt = recorded[0].endAt;
                    info.channelType = recorded[0].channelType;
                    if(recorded[0].description !== null) { info.description = recorded[0].description; }
                    if(recorded[0].extended !== null) { info.extended = recorded[0].extended; }
                }
            }
        }

        return infos;
    }

    /**
    * ライブ視聴用の m3u8 ファイルを生成
    * @param host: host
    * @param channelId: channel id
    * @param mode: config.MpegTsStreaming の index 番号
    * @return Promise<PLayList>
    */
    public async getLiveM3u8(host: string, isSecure: boolean, channelId: apid.ServiceItemId, mode: number): Promise<PLayList> {
        let channel = await this.servicesDB.findId(channelId);
        if(channel.length === 0) { throw new Error(StreamsModelInterface.channleIsNotFoundError); }

        const name = channel[0].name;
        const playList = '#EXTM3U\n'
        + `#EXTINF: ${ 0 }, ${ name }\n`
        + `${ isSecure ? 'https' : 'http' }://${ host }/api/streams/live/${ channelId }/mpegts?mode=${ mode }`

        return {
            name: encodeURIComponent(name + '.m3u8'),
            playList: playList,
        }
    }
}

export { StreamModelInfo, StreamsModelInterface, StreamsModel }
