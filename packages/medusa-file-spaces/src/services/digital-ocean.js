import fs from "fs"
import aws from "aws-sdk"
import { parse } from "path"
import { AbstractFileService, FileServiceUploadResult } from "@medusajs/medusa"
import { EntityManager } from "typeorm"
import stream from "stream"

class DigitalOceanService extends AbstractFileService {
  constructor({}, options) {
    super()

    this.bucket_ = options.bucket
    this.spacesUrl_ = options.spaces_url?.replace(/\/$/, "")
    this.accessKeyId_ = options.access_key_id
    this.secretAccessKey_ = options.secret_access_key
    this.region_ = options.region
    this.endpoint_ = options.endpoint
  }

  upload(file) {
    this.updateAwsConfig()

    const parsedFilename = parse(file.originalname)
    const fileKey = `${parsedFilename.name}-${Date.now()}${parsedFilename.ext}`
    const s3 = new aws.S3()
    var params = {
      ACL: "public-read",
      Bucket: this.bucket_,
      Body: fs.createReadStream(file.path),
      Key: fileKey,
    }

    return new Promise((resolve, reject) => {
      s3.upload(params, (err, data) => {
        if (err) {
          reject(err)
          return
        }

        if (this.spacesUrl_) {
          resolve({ url: `${this.spacesUrl_}/${data.Key}` })
        }

        resolve({ url: data.Location })
      })
    })
  }

  delete(file) {
    this.updateAwsConfig()

    const s3 = new aws.S3()
    var params = {
      Bucket: this.bucket_,
      Key: `${file}`,
    }

    return new Promise((resolve, reject) => {
      s3.deleteObject(params, (err, data) => {
        if (err) {
          reject(err)
          return
        }
        resolve(data)
      })
    })
  }


  async getUploadStreamDescriptor(fileData) {
    this.updateAwsConfig()

    const pass = new stream.PassThrough()
    
    const fileKey = `${fileData.name}-${Date.now()}.${fileData.ext}`
    const params = {
      ACL: fileData.acl ?? "private",
      Bucket: this.bucket_,
      Body: pass,
      Key: fileKey,
      contentType: fileData.contentType ?? 'text/csv'
    }
    
    const s3 = new aws.S3()
    return {
      writeStream: pass,
      promise: s3
        .upload(params)
        .promise(),
      url: `${this.spacesUrl_}/${fileKey}`,
      fileKey,
    }
  }

  async getDownloadStream(fileData) {
    this.updateAwsConfig()

    const s3 = new aws.S3()

    var params = {
      Bucket: this.bucket_,
      Key: `${fileData.key}`,
    }

    return s3.getObject(params).createReadStream()
  }

  async getPresignedDownloadUrl(fileData) {
    this.updateAwsConfig({
      signatureVersion: "v4",
    })

    const s3 = new aws.S3()

    var params = {
      Bucket: this.bucket_,
      Key: `${fileData.key}`,
      Expires: 60, // 60 seconds
    }

    return await s3.getSignedUrlPromise("getObject", params)
  }

  updateAwsConfig(additionalConfiguration = {}){
    aws.config.setPromisesDependency(null)
    aws.config.update({
      accessKeyId: this.accessKeyId_,
      secretAccessKey: this.secretAccessKey_,
      region: this.region_,
      endpoint: this.endpoint_,
      ...additionalConfiguration
    }, true)

  }
}

export default DigitalOceanService
