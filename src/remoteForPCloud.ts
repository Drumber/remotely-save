import { Vault, requestUrl } from "obsidian";
import { Client, createClient, oauth } from "pcloud-sdk-js";
import { PCloudConfig, RemoteItem, VALID_REQURL } from "./baseTypes";
import { decryptArrayBuffer, encryptArrayBuffer } from "./encrypt";
import { bufferToArrayBuffer, getFolderLevels, mkdirpInVault } from "./misc";
import { log } from "./moreOnLog";

export const PCLOUD_CREATE_APP_URL = "https://docs.pcloud.com/my_apps/";

export function createPCloudAuthorizeUrl(clientID: string) {
  const url = new URL("https://my.pcloud.com/oauth2/authorize");
  url.searchParams.append("client_id", clientID);
  url.searchParams.append("response_type", "code");
  return url.href;
}

export const DEFAULT_PCLOUD_CONFIG: PCloudConfig = {
  location: "us",
  accessToken: ""
};

export function updatePCloudLocation(location: string) {
  global.locationid = location === "us" ? 1 : 2;
}

export async function getOAuthTokenFromCode(code: string, clientID: string, appSecret: string) {
  const res = await oauth.getTokenFromCode(code, clientID, appSecret);
  return res;
}

export class WrappedPCloudClient {
  pCloudConfig: PCloudConfig;
  remoteBaseDir: string;
  client: Client;
  vaultFolderExists: boolean;
  saveUpdatedConfigFunc: () => Promise<any>;
  constructor(
    pCloudConfig: PCloudConfig,
    remoteBaseDir: string,
    saveUpdatedConfigFunc: () => Promise<any>
  ) {
    this.pCloudConfig = pCloudConfig;
    this.remoteBaseDir = remoteBaseDir;
    this.vaultFolderExists = false;
    this.saveUpdatedConfigFunc = saveUpdatedConfigFunc;
  }

  init = async () => {
    // check token
    if (
      this.pCloudConfig.accessToken === ""
    ) {
      throw Error("The user has not manually auth yet.");
    }

    if (this.client === undefined) {
      this.client = createClient(this.pCloudConfig.accessToken);
    }

    // check vault folder
    if (this.vaultFolderExists) {
      // pass
    } else {
      const res = await this.client.api("createfolderifnotexists", { params: { path: `/${this.remoteBaseDir}` } });
      if (res.result === 0) {
        this.vaultFolderExists = true;
      }
    }
  };

  createApiUrl = (method: string, params: any) => {
    const locations = {
      1: "api.pcloud.com",
      2: "eapi.pcloud.com"
    };

    const apiUrl = `https://${locations[global.locationid]}/${method}`;
    const reqUrl = new URL(apiUrl);
    reqUrl.searchParams.append("access_token", this.pCloudConfig.accessToken);

    for (const key in params) {
      reqUrl.searchParams.append(key, params[key]);
    }
    return reqUrl.href;
  }

  doApiRequest = async (method: string, params: any) => {
    const url = this.createApiUrl(method, params);

    if (VALID_REQURL) {
      return await requestUrl({
        url: url,
        headers: { "Cache-Control": "no-cache" },
      });
    } else {
      return await fetch(url);
    }
  }

}

interface Metadata {
  isfolder?: boolean;
  name?: string;
  id?: string;
  modified?: string;
  size?: number;
  hash?: number;
  path?: string;
}

const getPCloudPath = (fileOrFolderPath: string, remoteBaseDir: string) => {
  let key = fileOrFolderPath;
  if (fileOrFolderPath === "/" || fileOrFolderPath === "") {
    // special
    key = `/${remoteBaseDir}`;
  }
  if (!fileOrFolderPath.startsWith("/")) {
    key = `/${remoteBaseDir}/${fileOrFolderPath}`;
  }
  if (key.endsWith("/")) {
    key = key.substring(0, key.lastIndexOf("/"));
  }
  return key;
};

const getNormPath = (fileOrFolderPath: string, remoteBaseDir: string) => {
  if (
    !(
      fileOrFolderPath === `/${remoteBaseDir}` ||
      fileOrFolderPath.startsWith(`/${remoteBaseDir}/`)
    )
  ) {
    throw Error(
      `"${fileOrFolderPath}" doesn't starts with "/${remoteBaseDir}/"`
    );
  }
  return fileOrFolderPath.slice(`/${remoteBaseDir}/`.length);
};

const fromMetadataItemToRemoteItem = (x: Metadata, remoteBaseDir: string) => {
  let key = getNormPath(x.path || x.name, remoteBaseDir);
  if (x.isfolder === true && !key.endsWith("/")) {
    key = `${key}/`;
  }
  let etag = x.isfolder === false ? x.id + x.hash : x.id;

  return {
    key: key,
    lastModified: Date.parse(x.modified).valueOf(),
    size: x.size,
    remoteType: "pcloud",
    etag: etag,
  } as RemoteItem;
};

export const getPCloudClient = (
  pCloudConfig: PCloudConfig,
  remoteBaseDir: string,
  saveUpdatedConfigFunc: () => Promise<any>
) => {
  return new WrappedPCloudClient(
    pCloudConfig,
    remoteBaseDir,
    saveUpdatedConfigFunc
  );
};

export const getRemoteMeta = async (
  client: WrappedPCloudClient,
  fileOrFolderPath: string
) => {
  await client.init();
  const remotePath = getPCloudPath(fileOrFolderPath, client.remoteBaseDir);

  const res = await client.client.api("stat", { params: { path: remotePath } });
  // add path attribute
  res.metadata.path = remotePath;
  return fromMetadataItemToRemoteItem(res.metadata as Metadata, client.remoteBaseDir);
};

export const uploadToRemote = async (
  client: WrappedPCloudClient,
  fileOrFolderPath: string,
  vault: Vault,
  isRecursively: boolean = false,
  password: string = "",
  remoteEncryptedKey: string = "",
  foldersCreatedBefore: Set<string> | undefined = undefined,
  uploadRaw: boolean = false,
  rawContent: string | ArrayBuffer = ""
) => {
  await client.init();
  let uploadFile = fileOrFolderPath;
  if (password !== "") {
    uploadFile = remoteEncryptedKey;
  }
  uploadFile = getPCloudPath(uploadFile, client.remoteBaseDir);

  const isFolder = fileOrFolderPath.endsWith("/");

  if (isFolder && isRecursively) {
    throw Error("upload function doesn't implement recursive function yet!");
  } else if (isFolder && !isRecursively) {
    if (uploadRaw) {
      throw Error(`you specify uploadRaw, but you also provide a folder key!`);
    }
    // folder
    if (password === "") {
      // if not encrypted, mkdir a remote folder
      if (foldersCreatedBefore?.has(uploadFile)) {
        // pass
      } else {
        const res = await client.client.api("createfolderifnotexists", { params: { path: uploadFile } });
        res.metadata.path = uploadFile;
        const metadata = fromMetadataItemToRemoteItem(res.metadata as Metadata, client.remoteBaseDir);
        foldersCreatedBefore?.add(uploadFile);
        return metadata;
      }
    } else {
      // if encrypted, upload a fake file with the encrypted file name
      const res = await (await client.doApiRequest("file_open", { flags: 0x0040, path: uploadFile })).json;
      if (res.fd) {
        // close file descriptor
        await client.doApiRequest("file_close", { fd: res.fd });
      }
      return await getRemoteMeta(client, uploadFile);
    }
  } else {
    // file
    // we ignore isRecursively parameter here
    let localContent = undefined;
    if (uploadRaw) {
      if (typeof rawContent === "string") {
        localContent = new TextEncoder().encode(rawContent).buffer;
      } else {
        localContent = rawContent;
      }
    } else {
      localContent = await vault.adapter.readBinary(fileOrFolderPath);
    }
    let remoteContent = localContent;
    if (password !== "") {
      remoteContent = await encryptArrayBuffer(localContent, password);
    }

    const directoryPath = uploadFile.substring(0, uploadFile.lastIndexOf("/"));
    const fileName = uploadFile.substring(uploadFile.lastIndexOf("/") + 1);

    // create parent folders
    // this shouldn't be neccessary since its handled by the algorithm, however
    // I experienced some edge cases were the upload failed because of missing directories
    const folders = getFolderLevels(uploadFile).map((x) => getPCloudPath(x, client.remoteBaseDir));
    for (const folder of folders) {
      if (foldersCreatedBefore?.has(folder)) continue;
      await client.client.api("createfolderifnotexists", { params: { path: folder } });
      foldersCreatedBefore?.add(folder);
    }

    // upload the file
    await client.client.api("uploadfile", {
      method: "post",
      params: { path: directoryPath, nopartial: 1 },
      files: [{ file: new Blob([remoteContent]) as any, name: fileName }],
      onProgress: progress => {
        log.info(`Uploaded ${progress.loaded} bytes of ${progress.total}`);
      }
    });

    return await getRemoteMeta(client, uploadFile);
  }
};

export const listFromRemote = async (
  client: WrappedPCloudClient,
  prefix?: string
) => {
  if (prefix !== undefined) {
    throw Error("prefix not supported");
  }
  await client.init();

  const res = await client.client.api("listfolder", {
    params: { path: `/${client.remoteBaseDir}`, recursive: 1 }
  });

  if (res.result !== 0) {
    throw Error("Operation failed.");
  }

  let contents = [] as Array<RemoteItem>;

  const flattenMetadataTree = (node: Array<any>, path = ""): Array<any> => {
    return node.reduce((acc, val) => {
      const currPath = `${path}/${val.name}`;
      // since only the root node has 'path' set, we set it here manually
      val.path = currPath;

      // add current node
      const currNode = fromMetadataItemToRemoteItem(val as Metadata, client.remoteBaseDir);
      contents.push(currNode);

      if (Array.isArray(val.contents) && val.contents.length > 0) {
        // add child nodes
        return acc.concat(flattenMetadataTree(val.contents, currPath));
      }
      return acc.concat(val);
    }, []);
  };
  flattenMetadataTree(res.metadata.contents, res.metadata.path);

  return {
    Contents: contents
  };
};

const downloadFromRemoteRaw = async (
  client: WrappedPCloudClient,
  fileOrFolderPath: string,
): Promise<ArrayBuffer> => {
  await client.init();

  const path = getPCloudPath(fileOrFolderPath, client.remoteBaseDir);

  // open file descriptor
  const resFd = await (await client.doApiRequest("file_open", { path: path, flags: 0 })).json;
  if (resFd.result !== 0) {
    throw Error("Failed to open file descriptor.");
  }

  try {
    // get file size
    const resSize = await (await client.doApiRequest("file_size", { fd: resFd.fd })).json;
    if (resSize.result !== 0) {
      throw Error("Failed to get file size.");
    }

    // download the file
    const content = (await client.doApiRequest("file_pread",
      {
        fd: resFd.fd,
        offset: 0,
        count: resSize.size
      }
    )).arrayBuffer;
    if (content instanceof ArrayBuffer) {
      return content;
    } else {
      return await content();
    }
  } catch (err) {
    log.debug(err);
    throw err;
  } finally {
    // close file descriptor
    await client.doApiRequest("file_close", { fd: resFd.fd });
  }
};

export const downloadFromRemote = async (
  client: WrappedPCloudClient,
  fileOrFolderPath: string,
  vault: Vault,
  mtime: number,
  password: string = "",
  remoteEncryptedKey: string = "",
  skipSaving: boolean = false
) => {
  await client.init();

  const isFolder = fileOrFolderPath.endsWith("/");

  if (!skipSaving) {
    await mkdirpInVault(fileOrFolderPath, vault);
  }

  // the file is always local file
  // we need to encrypt it

  if (isFolder) {
    // mkdirp locally is enough
    // do nothing here
    return new ArrayBuffer(0);
  } else {
    let downloadFile = fileOrFolderPath;
    if (password !== "") {
      downloadFile = remoteEncryptedKey;
    }
    downloadFile = getPCloudPath(downloadFile, client.remoteBaseDir);
    const remoteContent = await downloadFromRemoteRaw(client, downloadFile);
    let localContent = remoteContent;
    if (password !== "") {
      localContent = await decryptArrayBuffer(remoteContent, password);
    }
    if (!skipSaving) {
      await vault.adapter.writeBinary(fileOrFolderPath, localContent, {
        mtime: mtime,
      });
    }
    return localContent;
  }
};

export const deleteFromRemote = async (
  client: WrappedPCloudClient,
  fileOrFolderPath: string,
  password: string = "",
  remoteEncryptedKey: string = ""
) => {
  if (fileOrFolderPath === "/") {
    return;
  }
  let remoteFileName = fileOrFolderPath;
  if (password !== "") {
    remoteFileName = remoteEncryptedKey;
  }
  remoteFileName = getPCloudPath(remoteFileName, client.remoteBaseDir);

  await client.init();
  try {
    await client.client.api("deletefile", { params: { path: remoteFileName } });
    // log.info(`delete ${remoteFileName} succeeded`);
  } catch (err) {
    console.error("some error while deleting");
    log.info(err);
  }
};

export const checkConnectivity = async (
  client: WrappedPCloudClient,
  callbackFunc?: any
) => {
  try {
    await client.init();
    const res = await client.client.userinfo();
    //log.debug("user info:", res)
    if (!res) {
      throw Error("Empty response.");
    }
    return true;
  } catch (err) {
    log.debug(err);
    if (callbackFunc !== undefined) {
      callbackFunc(err);
    }
    return false;
  }
};
