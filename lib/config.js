'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Config {
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = defaults;
    this.data = null;
  }

  load() {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
    if (!this.data || typeof this.data !== 'object') this.data = {};
    this.data.settings = { ...(this.defaults.settings || {}), ...(this.data.settings || {}) };
    this.data.servers = Array.isArray(this.data.servers) ? this.data.servers : [];
    if (!this.data.deviceId) this.data.deviceId = crypto.randomUUID();
    this.save();
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }
}

module.exports = Config;
