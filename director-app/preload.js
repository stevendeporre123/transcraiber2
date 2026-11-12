'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('director', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  testAuth: () => ipcRenderer.invoke('auth:test'),
  getOrgans: () => ipcRenderer.invoke('api:organs'),
  getMeetings: (opts) => ipcRenderer.invoke('api:meetings', opts),
  getMembers: (meetingId) => ipcRenderer.invoke('api:members', meetingId),
  updateMember: (meetingId, memberId, patch) => ipcRenderer.invoke('api:updateMember', meetingId, memberId, patch),
});
