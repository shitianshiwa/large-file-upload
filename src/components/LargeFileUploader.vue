<template>
  <div>
    <div class="upload-area">
      <input type="file" @change="handleFileChange" />
      <el-button @click="handleUpload" :disabled="uploadDisabled">上传</el-button>
      <el-button @click="handleResume" v-if="status === Status.Pause">恢复</el-button>
      <el-button @click="handlePause" :disabled="status !== Status.Uploading || !fileHash" v-else>暂停</el-button>
    </div>
    <div class="upload-progress">
      <div>计算文件Hash</div>
      <el-progress :percentage="hashPercentage"></el-progress>
      <div>总进度</div>
      <el-progress :percentage="fileUploadPercentage"></el-progress>
    </div>
    <div class="chunk-progress">
      <el-table :data="chunks" style="width: 100%">
        <el-table-column prop="chunkHash" label="切片hash" align="center"></el-table-column>
        <el-table-column label="大小(KB)" align="center" width="120">
          <template v-slot="{ row }">{{ row.size | kb }}</template>
        </el-table-column>
        <el-table-column label="进度" align="center">
          <template v-slot="{ row }">
            <el-progress :percentage="row.percentage" color="#66ccff"></el-progress>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script lang="ts">
import { Component, Vue } from "vue-property-decorator";

const CHUNK_SIZE = 10 * 1024 * 1024;
const SERVER_HOST_URL = "http://localhost:3000";

interface Request {
  url: string;
  method: string;
  data: string | FormData;
  headers: { [key: string]: string };
  onProgress?: (this: XMLHttpRequest, ev: ProgressEvent) => void;
  requests?: XMLHttpRequest[];
}

interface Chunk {
  chunk: Blob;
  i: number;
  percentage: number;
  size: number;
  fileHash: string;
  chunkHash: string;
}

enum Status {
  Wait = "WAIT",
  Pause = "PAUSE",
  Uploading = "UPLOADING"
}

@Component({
  filters: {
    kb(val: string) {
      return (Number(val) / 1024).toFixed(0);
    }
  }
})
export default class LargeFileUploader extends Vue {
  file: File | null = null;
  chunks: Chunk[] = null;
  worker: Worker = null;
  fileHash = "";
  hashPercentage = 0;
  requests: XMLHttpRequest[] = [];
  status: Status = Status.Wait;
  Status = Status;
  sleep(time: number) {
    return new Promise(resolve => setTimeout(resolve, time));
  }
  handleFileChange(e: InputEvent) {
    const file = (e.target as HTMLInputElement).files[0];
    if (!file) return;
    this.resetData();
    Object.assign(this.$data, this.$options.data);
    this.file = file;
  }
  request(request: Request) {
    return new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = request.onProgress;
      xhr.open(request.method, request.url);
      Object.keys(request.headers).forEach((key: string) =>
        xhr.setRequestHeader(key, request.headers[key])
      );
      xhr.send(request.data);
      xhr.onload = (e: Event) => {
        if (request.requests) {
          request.requests = request.requests.filter(item => item !== xhr);
        }
        resolve({ data: (e.target as XMLHttpRequest).response });
      };
      request.requests?.push(xhr);
    });
  }
  async handleUpload() {
    if (!this.file) return;
    this.status = Status.Uploading;
    const fileChunks = this.createFileChunks(this.file);
    this.fileHash = await ((this.calculateFileHash(
      fileChunks
    ) as unknown) as string);
    const { alreadyUploaded, uploadedChunks } = await this.verifyUpload(
      this.file.name,
      this.fileHash
    );
    if (alreadyUploaded) {
      this.$message.success("秒传成功");
      this.status = Status.Wait;
      return;
    }
    this.chunks = fileChunks.map(({ file }, i) => ({
      chunk: file,
      size: file.size,
      i,
      percentage: uploadedChunks.includes(i) ? 100 : 0,
      fileHash: this.fileHash as string,
      chunkHash: `${this.fileHash}-${i}`
    }));
    await this.uploadChunks(uploadedChunks);
  }
  createFileChunks(file: File, size = CHUNK_SIZE) {
    const fileChunks = [];
    for (let cur = 0; cur < file.size; cur += size) {
      fileChunks.push({ file: file.slice(cur, cur + size) });
    }
    return fileChunks;
  }
  async uploadChunks(uploadedChunks: string[] = []) {
    const requests = this.chunks
      .filter(({ chunkHash }) => !uploadedChunks.includes(chunkHash))
      .map(({ chunk, chunkHash, i }) => {
        const formData = new FormData();
        formData.append("chunk", chunk);
        formData.append("fileHash", this.fileHash);
        formData.append("chunkHash", chunkHash);
        formData.append("filename", this.file.name);
        return { formData, i };
      })
      .map(async ({ formData, i }) => {
        this.request({
          url: SERVER_HOST_URL,
          data: formData,
          headers: {},
          method: "POST",
          onProgress: this.createProgressHandler(this.chunks[i]),
          requests: this.requests
        });
      });
    await Promise.all(requests);
    if (uploadedChunks.length + requests.length === this.chunks.length) {
      await this.sleep(3000); // mergeRequest这个逼跑的也太快了
      await this.mergeRequest();
    }
  }
  async mergeRequest() {
    await this.request({
      url: `${SERVER_HOST_URL}/merge`,
      headers: { "content-type": "application/json" },
      data: JSON.stringify({
        filename: this.file.name,
        chunkSize: CHUNK_SIZE,
        fileHash: this.fileHash,
        requests: []
      }),
      method: "POST"
    });
    this.$message.success("上传成功");
    this.status = Status.Wait;
  }
  createProgressHandler(chunk: Chunk) {
    return (e: ProgressEvent) => {
      chunk.percentage = (e.loaded / e.total) * 100;
    };
  }
  get uploadDisabled() {
    return !this.file || [Status.Pause, Status.Uploading].includes(this.status);
  }
  get fileUploadPercentage() {
    if (!this.file || !this.chunks) {
      return 0;
    }
    const uploadedSize = this.chunks
      .map(item => item.size * item.percentage)
      .reduce((acc, cur) => acc + cur);
    return parseInt((uploadedSize / this.file.size).toFixed(2));
  }
  calculateFileHash(fileChunks: { file: Blob }[]) {
    return new Promise(resolve => {
      this.worker = new Worker("./hash.js");
      this.worker.postMessage({ fileChunks });
      this.worker.onmessage = (e: MessageEvent) => {
        const { percentage, hash } = e.data;
        this.hashPercentage = percentage;
        if (hash) {
          resolve(hash);
        }
      };
    });
  }
  async verifyUpload(filename: string, fileHash: string) {
    const { data } = (await this.request({
      url: `${SERVER_HOST_URL}/verify`,
      method: "POST",
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ filename, fileHash }),
      requests: []
    })) as { data: string };
    return JSON.parse(data);
  }
  resetData() {
    this.requests.forEach(xhr => xhr.abort());
    this.requests = [];
  }
  handlePause() {
    this.status = Status.Pause;
    this.resetData();
  }
  async handleResume() {
    this.status = Status.Uploading;
    const { uploadedChunks } = await this.verifyUpload(
      this.file.name,
      this.fileHash
    );
    await this.uploadChunks(uploadedChunks);
  }
}
</script>

<style scoped lang="scss"></style>
