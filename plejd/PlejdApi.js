const axios = require('axios').default;
const fs = require('fs');

const Configuration = require('./Configuration');
const Logger = require('./Logger');

const API_APP_ID = 'zHtVqXt8k4yFyk2QGmgp48D9xZr2G94xWYnF4dak';
const API_BASE_URL = 'https://cloud.plejd.com/parse/';
const API_LOGIN_URL = 'login';
const API_SITE_LIST_URL = 'functions/getSiteList';
const API_SITE_DETAILS_URL = 'functions/getSiteById';

const logger = Logger.getLogger('plejd-api');

class PlejdApi {
  config;
  deviceRegistry;
  sessionToken;
  siteId;
  siteDetails;

  constructor(deviceRegistry) {
    this.config = Configuration.getOptions();
    this.deviceRegistry = deviceRegistry;
  }

  async init() {
    logger.info('init()');
    const cache = await this.getCachedCopy();
    const cacheExists = cache && cache.siteId && cache.siteDetails && cache.sessionToken;

    logger.debug(`Prefer cache? ${this.config.preferCachedApiResponse}`);
    logger.debug(`Cache exists? ${cacheExists ? `Yes, created ${cache.dtCache}` : 'No'}`);

    if (this.config.preferCachedApiResponse && cacheExists) {
      logger.info(
        `Cache preferred. Skipping api requests and setting api data to response from ${cache.dtCache}`,
      );
      logger.silly(`Cached response: ${JSON.stringify(cache, null, 2)}`);
      this.siteId = cache.siteId;
      this.siteDetails = cache.siteDetails;
      this.sessionToken = cache.sessionToken;
    } else {
      try {
        await this.login();
        await this.getSites();
        await this.getSiteDetails();
        this.saveCachedCopy();
      } catch (err) {
        if (cacheExists) {
          logger.warn('Failed to get api response, using cached copy instead');
          this.siteId = cache.siteId;
          this.siteDetails = cache.siteDetails;
          this.sessionToken = cache.sessionToken;
        } else {
          logger.error('Api request failed, no cached fallback available', err);
          throw err;
        }
      }
    }
    this.deviceRegistry.setApiSite(this.siteDetails);
    this.deviceRegistry.cryptoKey = this.siteDetails.plejdMesh.cryptoKey;

    this.getDevices();
  }

  // eslint-disable-next-line class-methods-use-this
  async getCachedCopy() {
    logger.info('Getting cached api response from disk');

    try {
      const rawData = await fs.promises.readFile('/data/cachedApiResponse.json');
      const cachedCopy = JSON.parse(rawData);

      return cachedCopy;
    } catch (err) {
      logger.warn('No cached api response could be read. This is normal on the first run', err);
      return null;
    }
  }

  async saveCachedCopy() {
    logger.info('Saving cached copy');
    try {
      const rawData = JSON.stringify({
        siteId: this.siteId,
        siteDetails: this.siteDetails,
        sessionToken: this.sessionToken,
        dtCache: new Date().toISOString(),
      });
      await fs.promises.writeFile('/data/cachedApiResponse.json', rawData);
    } catch (err) {
      logger.error('Failed to save cache of api response', err);
    }
  }

  async login() {
    logger.info('login()');
    logger.info(`logging into ${this.config.site}`);

    logger.debug(`sending POST to ${API_BASE_URL}${API_LOGIN_URL}`);

    try {
      const response = await this._getAxiosInstance().post(API_LOGIN_URL, {
        username: this.config.username,
        password: this.config.password,
      });

      logger.info('got session token response');
      this.sessionToken = response.data.sessionToken;

      if (!this.sessionToken) {
        logger.error('No session token received');
        throw new Error('API: No session token received.');
      }
    } catch (error) {
      if (error.response.status === 400) {
        logger.error('Server returned status 400. probably invalid credentials, please verify.');
      } else if (error.response.status === 403) {
        logger.error(
          'Server returned status 403, forbidden. Plejd service does this sometimes, despite correct credentials. Possibly throttling logins. Waiting a long time often fixes this.',
        );
      } else {
        logger.error('Unable to retrieve session token response: ', error);
      }
      logger.verbose(`Error details: ${JSON.stringify(error.response, null, 2)}`);

      throw new Error(`API: Unable to retrieve session token response: ${error}`);
    }
  }

  async getSites() {
    logger.info('Get all Plejd sites for account...');

    logger.debug(`sending POST to ${API_BASE_URL}${API_SITE_LIST_URL}`);

    try {
      const response = await this._getAxiosInstance().post(API_SITE_LIST_URL);

      const sites = response.data.result;
      logger.info(
        `Got site list response with ${sites.length}: ${sites.map((s) => s.site.title).join(', ')}`,
      );
      logger.silly('All sites found:');
      logger.silly(JSON.stringify(sites, null, 2));

      const site = sites.find((x) => x.site.title === this.config.site);

      if (!site) {
        logger.error(`Failed to find a site named ${this.config.site}`);
        throw new Error(`API: Failed to find a site named ${this.config.site}`);
      }

      logger.info(`Site found matching configuration name ${this.config.site}`);
      logger.silly(JSON.stringify(site, null, 2));
      this.siteId = site.site.siteId;
    } catch (error) {
      logger.error('error: unable to retrieve list of sites. error: ', error);
      throw new Error(`API: unable to retrieve list of sites. error: ${error}`);
    }
  }

  async getSiteDetails() {
    logger.info(`Get site details for ${this.siteId}...`);

    logger.debug(`sending POST to ${API_BASE_URL}${API_SITE_DETAILS_URL}`);

    try {
      const response = await this._getAxiosInstance().post(API_SITE_DETAILS_URL, {
        siteId: this.siteId,
      });

      logger.info('got site details response');

      if (response.data.result.length === 0) {
        logger.error(`No site with ID ${this.siteId} was found.`);
        throw new Error(`API: No site with ID ${this.siteId} was found.`);
      }

      this.siteDetails = response.data.result[0];

      logger.info(`Site details for site id ${this.siteId} found`);
      logger.silly(JSON.stringify(this.siteDetails, null, 2));

      if (!this.siteDetails.plejdMesh.cryptoKey) {
        throw new Error('API: No crypto key set for site');
      }
    } catch (error) {
      logger.error(`Unable to retrieve site details for ${this.siteId}. error: `, error);
      throw new Error(`API: Unable to retrieve site details. error: ${error}`);
    }
  }

  getDevices() {
    logger.info('Getting devices from site details response...');

    this._getPlejdDevices();
    this._getRoomDevices();
    this._getSceneDevices();
  }

  _getAxiosInstance() {
    const headers = {
      'X-Parse-Application-Id': API_APP_ID,
      'Content-Type': 'application/json',
    };

    if (this.sessionToken) {
      headers['X-Parse-Session-Token'] = this.sessionToken;
    }

    return axios.create({
      baseURL: API_BASE_URL,
      headers,
    });
  }

  // eslint-disable-next-line class-methods-use-this
  _getDeviceType(hardwareId) {
    switch (parseInt(hardwareId, 10)) {
      case 1:
      case 11:
        return { name: 'DIM-01', type: 'light', dimmable: true };
      case 2:
        return { name: 'DIM-02', type: 'light', dimmable: true };
      case 3:
        return { name: 'CTR-01', type: 'light', dimmable: false };
      case 4:
        return { name: 'GWY-01', type: 'sensor', dimmable: false };
      case 5:
        return { name: 'LED-10', type: 'light', dimmable: true };
      case 6:
        return { name: 'WPH-01', type: 'switch', dimmable: false };
      case 7:
        return { name: 'REL-01', type: 'light', dimmable: false };
      case 8:
      case 9:
        // Unknown
        return { name: '-unknown-', type: 'light', dimmable: false };
      case 10:
        return { name: '-unknown-', type: 'light', dimmable: false };
      case 12:
        // Unknown
        return { name: '-unknown-', type: 'light', dimmable: false };
      case 13:
        return { name: 'Generic', type: 'light', dimmable: false };
      case 14:
      case 15:
      case 16:
        // Unknown
        return { name: '-unknown-', type: 'light', dimmable: false };
      case 17:
        return { name: 'REL-01', type: 'light', dimmable: false };
      case 18:
        return { name: 'REL-02', type: 'light', dimmable: false };
      case 19:
        // Unknown
        return { name: '-unknown-', type: 'light', dimmable: false };
      case 20:
        return { name: 'SPR-01', type: 'switch', dimmable: false };
      default:
        throw new Error(`Unknown device type with id ${hardwareId}`);
    }
  }

  _getPlejdDevices() {
    this.deviceRegistry.clearPlejdDevices();

    this.siteDetails.devices.forEach((device) => {
      const { deviceId } = device;

      const settings = this.siteDetails.outputSettings.find(
        (x) => x.deviceParseId === device.objectId,
      );

      let deviceNum = this.siteDetails.deviceAddress[deviceId];

      if (settings) {
        const outputs = this.siteDetails.outputAddress[deviceId];
        deviceNum = outputs[settings.output];
      }

      // check if device is dimmable
      const plejdDevice = this.siteDetails.plejdDevices.find((x) => x.deviceId === deviceId);
      const deviceType = this._getDeviceType(plejdDevice.hardwareId);
      const { name, type } = deviceType;
      let { dimmable } = deviceType;

      if (settings) {
        dimmable = settings.dimCurve !== 'NonDimmable';
      }

      const newDevice = {
        id: deviceNum,
        name: device.title,
        type,
        typeName: name,
        dimmable,
        roomId: device.roomId,
        version: plejdDevice.firmware.version,
        serialNumber: plejdDevice.deviceId,
      };

      if (newDevice.typeName === 'WPH-01') {
        // WPH-01 is special, it has two buttons which needs to be
        // registered separately.
        const inputs = this.siteDetails.inputAddress[deviceId];
        const first = inputs[0];
        const second = inputs[1];

        this.deviceRegistry.addPlejdDevice({
          ...newDevice,
          id: first,
          name: `${device.title} left`,
        });

        this.deviceRegistry.addPlejdDevice({
          ...newDevice,
          id: second,
          name: `${device.title} right`,
        });
      } else {
        this.deviceRegistry.addPlejdDevice(newDevice);
      }
    });
  }

  _getRoomDevices() {
    if (this.config.includeRoomsAsLights) {
      logger.debug('includeRoomsAsLights is set to true, adding rooms too.');
      this.siteDetails.rooms.forEach((room) => {
        const { roomId } = room;
        const roomAddress = this.siteDetails.roomAddress[roomId];

        const deviceIdsByRoom = this.deviceRegistry.getDeviceIdsByRoom(roomId);

        const dimmable = deviceIdsByRoom
          && deviceIdsByRoom.some((deviceId) => this.deviceRegistry.getDevice(deviceId).dimmable);

        const newDevice = {
          id: roomAddress,
          name: room.title,
          type: 'light',
          typeName: 'Room',
          dimmable,
        };

        this.deviceRegistry.addRoomDevice(newDevice);
      });
      logger.debug('includeRoomsAsLights done.');
    }
  }

  _getSceneDevices() {
    // add scenes as switches
    const scenes = this.siteDetails.scenes.filter((x) => x.hiddenFromSceneList === false);

    scenes.forEach((scene) => {
      const sceneNum = this.siteDetails.sceneIndex[scene.sceneId];
      const newScene = {
        id: sceneNum,
        name: scene.title,
        type: 'switch',
        typeName: 'Scene',
        dimmable: false,
        version: '1.0',
        serialNumber: scene.objectId,
      };

      this.deviceRegistry.addScene(newScene);
    });
  }
}

module.exports = PlejdApi;
