const path = require("path");
const fse = require("fs-extra");
const multiparty = require("multiparty");

const UPLOAD_DIR = path.resolve(__dirname, "..", "target");

const getFileExt = filename =>
  filename.slice(filename.lastIndexOf("."), filename.length);

const getReqData = req =>
  new Promise(resolve => {
    let chunk = "";
    req.on("data", data => {
      chunk += data;
    });
    req.on("end", () => {
      resolve(JSON.parse(chunk));
    });
  });

const getUploadedChunks = async filehash => {
  const filePath = path.resolve(UPLOAD_DIR, filehash);
  await (fse.existsSync(filePath) ? fse.readdir(filePath) : []);
};

const pipeStream = (path, writeStream) =>
  new Promise(resolve => {
    const readStream = fse.createReadStream(path);
    readStream.on("end", () => {
      fse.unlinkSync(path);
      resolve();
    });
    readStream.pipe(writeStream);
  });

const mergeFileChunks = async (filePath, fileHash, chunkSize) => {
  const chunkDir = path.resolve(UPLOAD_DIR, fileHash);
  const chunks = await fse.readdir(chunkDir);
  chunks.sort((a, b) => a.split("-")[1] - b.split("-")[1]);
  await Promise.all(
    chunks.map((chunk, i) =>
      pipeStream(
        path.resolve(chunkDir, chunk),
        fse.createWriteStream(filePath, {
          start: i * chunkSize,
          end: (i + 1) * chunkSize
        })
      )
    )
  );
  fse.rmdirSync(chunkDir);
};

module.exports = class {
  async handleFormData(req, res) {
    const multipart = new multiparty.Form();
    multipart.parse(req, async (err, fields, files) => {
      if (err) return;
      const chunk = files.chunk[0];
      const fileHash = fields.fileHash[0];
      const chunkHash = fields.chunkHash[0];
      const filename = fields.filename[0];
      const chunkDir = path.resolve(UPLOAD_DIR, fileHash);
      const filePath = path.resolve(
        UPLOAD_DIR,
        `${fileHash}${getFileExt(filename)}`
      );
      if (fse.existsSync(filePath)) {
        res.end("file already exists.");
        return;
      }
      if (!fse.existsSync(chunkDir)) {
        await fse.mkdir(chunkDir);
      }
      await fse.move(chunk.path, path.resolve(chunkDir, chunkHash));
      res.end("chunk received.");
    });
  }
  async handleMerge(req, res) {
    const data = await getReqData(req);
    const { filename, chunkSize, fileHash } = data;
    const filePath = path.resolve(
      UPLOAD_DIR,
      `${fileHash}${getFileExt(filename)}`
    );
    await mergeFileChunks(filePath, fileHash, chunkSize);
    res.end(JSON.stringify({ code: 0, message: "file merge success." }));
  }
  async handleVerifyUpload(req, res) {
    const data = await getReqData(req);
    const { filename, fileHash } = data;
    const filePath = path.resolve(
      UPLOAD_DIR,
      `${fileHash}${getFileExt(filename)}`
    );
    if (fse.existsSync(filePath)) {
      res.end(
        JSON.stringify({
          alreadyUploaded: true
        })
      );
    } else {
      res.end(
        JSON.stringify({
          alreadyUploaded: false,
          uploadedChunks: (await getUploadedChunks(fileHash)) || []
        })
      );
    }
  }
};
