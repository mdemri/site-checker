const MongoClient = require('mongodb').MongoClient;
const Promise = require('bluebird');
const _ = require('lodash');
const request = require('request');
const Slack = require('slack-node');
let config = {};

try {
    config = require('./config.js');
}
catch (e) { }

const connectionString = process.env.MONGO_URL || config.MONGO_URL;
let database = undefined;

let all = 0;
let ok = 0;
let errors = 0;

const webhookUri = process.env.WEBHOOK_URL || config.WEBHOOK_URL;
const channel = process.env.CHANNEL || config.CHANNEL;
const slack = new Slack();
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
    Promise.map(urls, (url) => {
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
    }, { concurrency: 10 }).all().then((results) => {
        console.log('all done');
        let msg = '';
        if (failedUrls.length) {
            msg += '***** Site Checker - Start *****\r\n';
            _.forEach(failedUrls, (url) => {
                msg += url + ' is DOWN!\r\n';
            });
            msg += '***** Site Checker - End *****\r\n';
            notifySlack(msg);
        }
        database.close();
    });

}

const prefixes = ['backoffice'] //, 'analytics', 'cms', 'stellarbridge', 'sitesbuilder', 'plugins', 'api'];

const getUrlsFromDatabase = (db) => {
    var websites = db.collection('websites');
    const websitesSel = {
        isPublished: true,
        is_deleted: { $ne: true },
        isTemplate: { $ne: true },
        'settings.business_unit_id': { $ne: null }
    };
    const websitesProj = {
        'settings.domains': 1,
        _id: 0
    };
    const context = {};
    websites.find(websitesSel, websitesProj)
        .toArray()
        .then((docs) => {
            docs = _.filter(_.flatMap(docs, getDomain), (url) => !!url);
            context.siteUrls = _.map(docs, (url) => 'http://' + url.trim());
        })
        .then(() => {
            const operations = db.collection('operations');
            return operations.find({}, { domain: 1, _id: 0 }).toArray();
        })
        .then((domains) => {
            context.appUrls = [];
            _.forEach(domains, (x) => {
                _.forEach(prefixes, (prefix) => {
                    context.appUrls.push(`https://${prefix}.${x.domain}`);
                });
            });
        })
        .then(() => {
            let urls = context.siteUrls;
            urls = urls.concat(context.appUrls);
            checkUrls(urls);
        })
        .catch((err) => {
            console.log('Error while retreiving URLs from database: ' + JSON.stringify(err, null, 2));
        });
}

