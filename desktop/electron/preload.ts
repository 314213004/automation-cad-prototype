import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface OpenCadPayload {
  path: string;
  source: 'menu' | 'drop';
}

const desktopApi = {
  version: () => ipcRenderer.invoke('app:version'),
  extensionBaseUrl: pathToFileURL(join(__dirname, '..', 'dist') + '/').href,
  openCadDialog: () => ipcRenderer.invoke('cad:open-dialog'),
  readFileBuffer: (filePath: string) => ipcRenderer.invoke('cad:read-file', filePath),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  exportFile: (name: string, data: Uint8Array | string) => ipcRenderer.invoke('export:saveFile', name, data),
  exportReport: (payload: { html: string; projectName?: string }) => ipcRenderer.invoke('export:report', payload),
  packs: {
    list: () => ipcRenderer.invoke('packs:list'),
    chooseZip: () => ipcRenderer.invoke('packs:choose-zip'),
    importZip: (zipPath: string) => ipcRenderer.invoke('packs:import-zip', zipPath),
    setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('packs:set-enabled', id, enabled),
    remove: (id: string) => ipcRenderer.invoke('packs:remove', id),
    listParts: (filter?: { q?: string; category?: string; packId?: string }) => ipcRenderer.invoke('packs:list-parts', filter ?? {})
  },
  agent: {
    info: () => ipcRenderer.invoke('agent:info')
  },
  factory: {
    info: () => ipcRenderer.invoke('factory:info'),
    status: () => ipcRenderer.invoke('factory:status'),
    list: () => ipcRenderer.invoke('factory:list'),
    getConfig: () => ipcRenderer.invoke('factory:config'),
    connect: (config: unknown) => ipcRenderer.invoke('factory:connect', config),
    disconnect: () => ipcRenderer.invoke('factory:disconnect'),
    browse: (nodeId?: string) => ipcRenderer.invoke('factory:browse', nodeId),
    readTags: (ids: string[]) => ipcRenderer.invoke('factory:read-tags', ids),
    writeTag: (id: string, value: unknown) => ipcRenderer.invoke('factory:write-tag', id, value),
    subscribe: (ids: string[]) => ipcRenderer.invoke('factory:subscribe', ids),
    onValues: (callback: (value: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value);
      ipcRenderer.on('factory:values', listener);
      return () => ipcRenderer.removeListener('factory:values', listener);
    },
    onStatus: (callback: (status: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
      ipcRenderer.on('factory:status', listener);
      return () => ipcRenderer.removeListener('factory:status', listener);
    }
  },
  plc: {
    info: () => ipcRenderer.invoke('plc:info'),
    status: () => ipcRenderer.invoke('plc:status'),
    list: () => ipcRenderer.invoke('plc:list'),
    getConfig: () => ipcRenderer.invoke('plc:config'),
    connect: (config: unknown) => ipcRenderer.invoke('plc:connect', config),
    disconnect: () => ipcRenderer.invoke('plc:disconnect'),
    read: (id: string) => ipcRenderer.invoke('plc:read', id),
    readAll: () => ipcRenderer.invoke('plc:read-all'),
    write: (id: string, value: unknown) => ipcRenderer.invoke('plc:write', id, value),
    force: (id: string, value: unknown) => ipcRenderer.invoke('plc:force', id, value),
    onValues: (callback: (values: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, values: unknown) => callback(values);
      ipcRenderer.on('plc:values', listener);
      return () => ipcRenderer.removeListener('plc:values', listener);
    },
    onStatus: (callback: (status: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
      ipcRenderer.on('plc:status', listener);
      return () => ipcRenderer.removeListener('plc:status', listener);
    }
  },
  onOpenCad: (callback: (payload: OpenCadPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: OpenCadPayload) => callback(payload);
    ipcRenderer.on('desktop:open-cad', listener);
    return () => ipcRenderer.removeListener('desktop:open-cad', listener);
  },
  onImportPack: (callback: (payload: { path: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { path: string }) => callback(payload);
    ipcRenderer.on('desktop:import-pack', listener);
    return () => ipcRenderer.removeListener('desktop:import-pack', listener);
  },
  onSetDomain: (callback: (domain: 'mech' | 'elec') => void) => {
    const listener = (_event: Electron.IpcRendererEvent, domain: 'mech' | 'elec') => callback(domain);
    ipcRenderer.on('desktop:set-domain', listener);
    return () => ipcRenderer.removeListener('desktop:set-domain', listener);
  }
};

contextBridge.exposeInMainWorld('desktop', desktopApi);
