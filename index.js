const MongoClient = require('mongodb').MongoClient;
const Promise = require('bluebird');
const _ = require('lodash');
const request = require('request');
const Slack = require('slack-node');
const config = {};

try {
    config = require('./config.json');
}
catch (e) { }

const connectionString = process.env.MONGO_URL || config.MONGO_URL;
let database = undefined;

let all = 0;
let ok = 0;
let errors = 0;

const webhookUri = process.env.WEBHOOK_URL || config.WEBHOOK_URL;
const channel = process.env.CHANNEL || config.CHANNEL;
var slack = new Slack();
slack.setWebhook(webhookUri);

var failedUrls = [];

var notifySlack = function (msg) {
    slack.webhook({
        channel: channel,
        username: "webhookbot",
        icon_emoji: ":ghost:",
        text: msg
    }, function (err, response) {
        // console.log(response);
    });
}

MongoClient.connect(
    connectionString,
    {
        poolSize: process.env.MONGO_POOL_SIZE || 10,
        promiseLibrary: Promise,
        sslValidate: false,
    })
    .then(function (db) {
        database = db;
        getUrlsFromDatabase(db);
    });


var getDomain = function (doc) {
    if (doc.settings && doc.settings.domains) {
        return doc.settings.domains;
    } else {
        return [];
    }
}

var checkUrls = function (urls) {
    all = urls.length;

    var requestAsync = Promise.promisify(request);
    urls = _.map(urls, function (url) { return 'http://' + url.trim(); })
    Promise.map(urls, function (url) {
        return requestAsync(url)
            .then(function (res) {
                res.body = null;
                if (res.statusCode >= 400) failedUrls.push(url);
                //console.log(url + ' request done: ' + JSON.stringify(res, null, 2));
            })
            .catch(function (err) {
                //console.log(url + ' request ERROR: ' + JSON.stringify(err, null, 2));
                failedUrls.push(url);
            });
    }, { concurrency: 10 }).all().then(function (results) {
        console.log('all done');
        failedUrls.length && notifySlack('***** Site Checker - Start *****');
        _.each(failedUrls, function(url) {
            notifySlack(url + ' is DOWN!')
        });
        failedUrls.length && notifySlack('***** Site Checker - End *****');
        database.close();
    });

}

const getUrlsFromDatabase = function (db) {
    var selection = {
        isPublished: true,
        is_deleted: { $ne: true },
        isTemplate: { $ne: true },
        'settings.business_unit_id': { $ne: null }
    }
    var projection = {
        'settings.domains': 1,
        _id: 0
    }
    var websites = db.collection('websites')
    websites.find(selection, projection)
        .toArray()
        .then(function (docs) {
            docs = _.filter(_.flatMap(docs, getDomain), function (url) { return !!url; });
            checkUrls(docs)
            return docs;
        })
        .catch(function (err) {
            console.log('Error while retreiving URLs from database: ' + JSON.stringify(err, null, 2))
        });
}

