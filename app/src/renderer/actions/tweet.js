/* @flow */
import fs from 'fs'
import path from 'path'
import Config from 'electron-config'
import Twitter from 'twit'
import axios from 'axios'
import adapter from 'axios/lib/adapters/http'
import AWS from 'aws-sdk'
import _ from 'lodash'

import type Twit from 'twit'
import type { ImageTweet, Image, ImageUrl, Label } from 'types/imageTweet'
import type { User } from 'types/user'

import * as ACTION from 'vuex/action-types'
import * as MUTATION from 'vuex/mutation-types'

import store from 'vuex/store'

import appEnv from '../../../../env'

const { app } = require('electron').remote // eslint-disable-line

function createClient (): Twit {
  const config = new Config()
  const accessToken: string = config.get('twitter_access_token')
  const accessSecret: string = config.get('twitter_access_secret')

  return new Twitter({
    consumer_key: appEnv.TWITTER_KEY,
    consumer_secret: appEnv.TWITTER_SECRET,
    access_token: accessToken,
    access_token_secret: accessSecret
  })
}

function baseUrlToImageUrl (url: string): ImageUrl {
  return {
    base: url,
    small: `${url}:small`,
    medium: `${url}:medium`,
    large: `${url}:large`,
    original: `${url}:orig`
  }
}

async function getImageTweetId (): Promise<Array<string>> {
  const client = createClient()

  try {
    let tweets = await client.get('statuses/home_timeline', { count: 200 })

    // 複数枚画像ツイート
    tweets = tweets.data
      .filter(t => {
        return 'extended_entities' in t
      })
      .filter(t => {
        return 'media' in t.extended_entities
      })
      .filter(t => {
        return t.user.protected === false
      })
      .filter(t => {
        return t.extended_entities.media[0].expanded_url.match(/photo/)
      })

    return tweets.map(t => {
      return t.id_str
    })
  } catch (e) {
    return []
  }
}

async function getUserDataFromTweetID (tweetID: string): Promise<Object> {
  const client = createClient()
  const tweet = await client.get(`statuses/show/${tweetID}`, {})
  return tweet.data.user
}

async function getImageTweetFromID (id: string): Promise<ImageTweet | any> {
  const client = createClient()

  try {
    const data = await getUserDataFromTweetID(id)
    if (data === undefined) {
      throw new Error('ユーザの情報が取得できませんでした')
    }
    const user: User = {
      id: data.id,
      name: data.name,
      screen_name: data.screen_name,
      iconUrl: data.profile_image_url,
      following: true
    }

    const tweet = await client.get(`statuses/show/${id}`, {})
    if ('errors' in tweet.data) {
      throw new Error(tweet.data.errors[0].message)
    }

    const images: Array<Image> = tweet.data.extended_entities.media.map(media => {
      const image: Image = {
        url: baseUrlToImageUrl(media.media_url),
        labels: [],
        rand: Math.random(),
        downloaded: false
      }
      return image
    })

    let fav = 0
    if ('retweeted_status' in tweet.data) {
      const originalUser = {
        id: tweet.data.retweeted_status.user.id,
        name: tweet.data.retweeted_status.user.name,
        screen_name: tweet.data.retweeted_status.user.screen_name,
        iconUrl: tweet.data.retweeted_status.user.profile_image_url,
        following: tweet.data.retweeted_status.user.following
      }
      fav = tweet.data.retweeted_status.favorite_count

      const imageTweet: ImageTweet = {
        id,
        user: originalUser,
        text: tweet.data.text,
        date: tweet.data.created_at,
        images,
        retweet: tweet.data.retweet_count,
        retweet_user: user,
        retweeted: tweet.data.retweeted,
        fav,
        faved: tweet.data.favorited,
        labelled: false,
        rand: Math.random()
      }
      return imageTweet
    } else {
      const user: User = {
        id: data.id,
        name: data.name,
        screen_name: data.screen_name,
        iconUrl: data.profile_image_url,
        following: true
      }
      fav = tweet.data.favorite_count
      const imageTweet: ImageTweet = {
        id,
        user,
        text: tweet.data.text,
        date: tweet.data.created_at,
        images,
        retweet: tweet.data.retweet_count,
        retweet_user: null,
        retweeted: tweet.data.retweeted,
        fav,
        faved: tweet.data.favorited,
        labelled: false,
        rand: Math.random()
      }
      return imageTweet
    }
  } catch (e) {
    console.error(e)
    return {}
  }
}

async function imageToLabel (image: Image): Promise<Array<Label>> {
  // for (const tweet: ImageTweet of store.state.tweets.imageTweets) {
  //   for (const image: Image of tweet.images) {
  //     if (image.url.base === url) {
  //       return image.labels
  //     }
  //   }
  // }

  const response = await axios({
    method: 'get',
    url: image.url.base,
    responseType: 'arraybuffer'
  })

  const rekognition = new AWS.Rekognition({
    accessKeyId: appEnv.AWS_ACCESS_KEY_ID,
    secretAccessKey: appEnv.AWS_SECRET_ACCESS_KEY,
    region: 'us-east-1'
  })
  var params = {
    Image: {
      Bytes: response.data
    }
  }

  const dataPromise: Promise<Object> = rekognition
    .detectLabels(params)
    .promise()
  return dataPromise.then(data => {
    const labels: Array<Label> = data.Labels.map(l => {
      const label: Label = {
        name: l.Name,
        score: l.Confidence,
        rand: Math.random()
      }
      return label
    })
    return labels
  })
}

function tweetToLabelTweet (tweet: ImageTweet): Promise<ImageTweet> {
  return new Promise((resolve, reject) => {
    try {
      for (const image of tweet.images) {
        imageToLabel(image).then((labels: Array<Label>) => {
          try {
            image.labels = labels
            tweet.labelled = true
          } catch (e) {
            console.error(e)
            tweet.labelled = true
          }
        })
      }
      resolve(tweet)
    } catch (e) {
      console.error(e)
      tweet.labelled = true
      reject(e)
    }
  }).then(tweet => {
    return tweet
  })
}

export default {
  [ACTION.SET_IMAGE_TWEETS]: async function ({ commit }: { commit: Function }) {
    const imageTweetIds: Array<string> = await getImageTweetId()
    const imageTweetsFromIDsPromise: Array<Promise<ImageTweet>> = imageTweetIds.map((id: string) => getImageTweetFromID(id))
    let imageTweets: Array<ImageTweet> = await Promise.all(
      imageTweetsFromIDsPromise
    )

    // 情報を取得できなかったツイートを削除
    imageTweets = imageTweets.filter(tweet => 'id' in tweet)

    // 画像にラベルを付与
    const labeledImageTweetsPromise: Array<Promise<ImageTweet>> = imageTweets.map((tweet: ImageTweet) => {
      return tweetToLabelTweet(tweet)
    })
    imageTweets = await Promise.all(labeledImageTweetsPromise)

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    // 全てのラベリングが終わるまでここで止める
    while (true) {
      const allLabelled = _.map(imageTweets, 'labelled')
      await sleep(1000)
      if (!allLabelled.includes(false)) {
        break
      }
    }

    imageTweets = _.unionWith(
      imageTweets,
      store.state.tweets.imageTweets,
      (a, b) => a.id === b.id
    )

    // 機械学習用ダウンロード処理
    if (process.env.NODE_ENV === 'production' && store.state.debug.saveMode) {
      comicsAndOthersDownload(imageTweets)
    }

    // ラベルが存在しないツイートを削除
    imageTweets = imageTweets.filter(tweet => {
      const images: Array<Image> = tweet.images.filter(
        image => image.labels !== []
      )
      return images !== []
    })
    imageTweets = _.take(imageTweets, store.state.settings.imageCount)

    commit(MUTATION.SET_IMAGE_TWEETS, imageTweets)

    commit(MUTATION.START_DISPLAY_REFRESH)
    setTimeout(() => {
      commit(MUTATION.END_DISPLAY_REFRESH)
    }, 2500)
  },
  [ACTION.START_LOAD_IMAGE_TWEETS]: function ({ commit }: { commit: Function }) {
    commit(MUTATION.START_LOAD_IMAGE_TWEETS)
  },
  [ACTION.END_DISPLAY_REFRESH]: function ({ commit }: { commit: Function }) {
    commit(MUTATION.END_DISPLAY_REFRESH)
  },
  [ACTION.RETWEET]: async function (
    { commit }: Function,
    { id }: { id: string }
  ) {
    const client: Twit = createClient()
    await client.post('statuses/retweet/:id', { id })
    commit(MUTATION.RETWEET, id)
  },
  [ACTION.FAV]: async function (
    { commit }: { commit: Function },
    { id }: { id: string }
  ) {
    const client: Twit = createClient()
    await client.post('favorites/create', { id })
    commit(MUTATION.FAV, id)
  },
  [ACTION.FOLLOW]: async function (
    { commit }: { commit: Function },
    { userID }: { userID: string }
  ) {
    const client: Twit = createClient()
    await client.post('friendships/create', { id: userID })
    commit(MUTATION.FOLLOW, userID)
  }
}

function comicsAndOthersDownload (imageTweets: Array<ImageTweet>) {
  for (const tweet of imageTweets) {
    for (const image of tweet.images) {
      if (!image.downloaded) {
        if (
          image.labels.map(label => label.name).includes('Comics') ||
          image.labels.map(label => label.name).includes('Manga')
        ) {
          axios({
            method: 'get',
            url: image.url.base,
            responseType: 'stream',
            adapter
          }).then(response => {
            response.data.pipe(
              fs.createWriteStream(
                path.join(
                  app.getPath('home'),
                  'Desktop',
                  'Comics',
                  image.url.base.split('/').pop()
                )
              )
            )
          })
        } else {
          axios({
            method: 'get',
            url: image.url.base,
            responseType: 'stream',
            adapter
          }).then(response => {
            response.data.pipe(
              fs.createWriteStream(
                path.join(
                  app.getPath('home'),
                  'Desktop',
                  'Others',
                  image.url.base.split('/').pop()
                )
              )
            )
          })
        }
      }
    }
  }
}
