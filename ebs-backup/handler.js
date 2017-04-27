'use strict';

const aws = require('aws-sdk');
const ec2 = new aws.EC2({region: 'ap-northeast-1'});
const co = require('co');
const _ = require('lodash');

/**
 * バックアップ対象のインスタンス一覧を取得します。
 */
function* fetchTargetInstances() {
  const params = {
    Filters: [
      {
        Name: 'tag-key',
        Values: [
          'Backup-Generation'
        ]
      }
    ],
    DryRun: false
  }
  return yield ec2.describeInstances(params).promise();
}

/**
 * スナップショットを作成します。
 * @param {Object} instance 
 * @return {Array} promise
 */
function* createSnapshot(instance) {
  if (!instance) return;

  let promiseList = [];
  instance.volumeId.forEach(volume => {
    const params = {
      VolumeId: volume,
      Description: `${instance.description}${volume}`,
      DryRun: true
    }
    console.log(`volumeId : ${volume}    description : ${instance.description}`);
    promiseList.push(ec2.createSnapshot(params).promise());
  });
  return yield promiseList;
}

/**
 * スナップショットにタグを付与する。
 * @param {Array} tags id:スナップショットID、name:EC2のName、volumeId:ボリュームIDを格納したオブジェクトの配列
 */
function* createSnapshotTags(tags) {

  let promiseList = [];
  tags.forEach(tag => {
    const params = {
      Resources: [
        tag.id
      ],
      Tags: [
        {
          Key: 'Name',
          Value: tag.name
        },
        {
          Key: 'volumeId',
          Value: tag.volumeId
        }
      ]
    }
    promiseList.push(ec2.createTags(params).promise());
  });
  return yield promiseList;
}

/**
 * ボリュームIDをキーにスナップショット一覧を取得します。
 * 
 * @param {String} volumeId EBSのボリュームID
 */
function* fetchSnapshotByVolumeId(volumeId) {

  const params = {
    Filters: [
      {
        Name: 'volume-id',
        Values: [
          volumeId
        ]
      }
    ]
  }
  return yield ec2.describeSnapshots(params).promise();
}


/**
 * スナップショットのdescriptionをキーにスナップショット一覧を取得します。
 * 
 * @param {String} description 既存スナップショットのdescription
 */
function* fetchSnapshotByDescription(description) {
  
  const params = {
    Filters: [
      {
        Name: 'description',
        Values: [
          description
        ]
      }
    ]
  }
  return yield ec2.describeSnapshots(params).promise();
}


/**
 * スナップショットのNameタグをキーにスナップショット一覧を取得します。
 * 
 * @param {String} name 既存スナップショットのNameタグ
 */
function* fetchSnapshotByTagName(name) {
  const params = {
    Filters: [
      {
        Name: 'tag-key',
        Values: [
          'Name'
        ]
      },
      {
        Name: 'tag-value',
        Values: [
          name
        ]
      }
    ]
  }
  return yield ec2.describeSnapshots(params).promise();
}

/**
 * 削除対象のスナップIDリストを元に古いスナップショットを削除する。
 * 
 * @param {Array} deleteIds 
 */
function* deleteSnapshot(deleteIds) {
  let promiseList = [];
  deleteIds.forEach(id => {
    const params = {
      SnapshotId: id,
      DryRun: true
    };
    promiseList.push(ec2.deleteSnapshot(params).promise());
  });
  if (promiseList.length < 1) {
      console.log('nothing delete snapshot');
      return;
  }
  return yield promiseList;
}

/**
 * ボリュームID単位で削除対象のスナップショットIDを抽出する。
 * @param {Object} data describeSnapshotsの戻り値
 * @param {String} generation 世代管理数の文字列
 * @return {Array} 削除対象のスナップショットID
 */
function parseDeleteSnapshotIds(data, generation) {
  let deleteIds = [];
  if (generation == 0 || data.Snapshots.length <= generation) return deleteIds;
  const delete_num = data.Snapshots.length - generation;
  // 作成日時の古い順に並べる
  data.Snapshots.sort((a, b) => {
    if (a.StartTime > b.StartTime) return 1;
    if (a.StartTime < b.StartTime) return -1;
    return 0;
  });
  let i = 0;
  while(i < delete_num) {
    deleteIds.push(data.Snapshots[i].SnapshotId);
    i=(i+1)|0;
  };
  return deleteIds;
}

/**
 * インスタンス情報をパースして、バックアップ対象のEBSのタグ情報を付加します。
 * 
 * @param {Object} data ec2.describeInstancesの戻り値
 * @return {Array} 
 */
function parseDescriptions(data) {
  let descriptions = {};
  data.Reservations.forEach(reservation => {
    reservation.Instances.forEach(instance => {
      let description = {};
      description.volumeId = [];
      description.id = instance.InstanceId;
      // タグをパース
      instance.Tags.forEach(tag => {
        if (tag.Key == 'Backup-Generation') {
          description.generation = tag.Value|0;
        } else if (tag.Key == 'Name') {
          description.name = tag.Value;
        }
      });

      // 世代管理しないものは次へ
      if (description.generation < 1) return;

      // ブロックデバイスをパース
      instance.BlockDeviceMappings.forEach(bdm => {
        if (!bdm.Ebs) return;
        description.volumeId.push(bdm.Ebs.VolumeId);
      });
      description.description = `Auto Snapshot ${description.name}  volumeId: `;
      descriptions[description.id] = description;
    });
  });
  return descriptions;
}

/**
 * Backup-Generation というタグのついたインスタンスに紐づくEBSのスナップショットを作成します。
 * 
 * `sls invoke local -f ebsBackup --stage dev -v`
 */
module.exports.backup = (event, context, callback) => {

  co(function*() {
    try {
      const instances = parseDescriptions(yield fetchTargetInstances());
      // インスタンス単位で処理する。
      for(let key in instances) {
        const instance = instances[key];
        try {
          const result = yield createSnapshot(instance);
          // 結果からスナップショットのタグ情報を作成する。
          let tags = [];
          result.forEach(r => {
            let tag = {
              id: r.SnapshotId,
              volumeId: r.VolumeId,
              name: instance.name
            };
            tags.push(tag);
          });
          // タグを付与します。
          yield createSnapshotTags(tags);
        } catch (err) {
          // インスタンス単位で処理しているため、スナップショット作成エラーは握りつぶす
          console.log(err);
        }
        let deleteIds = [];
        for(let k in instance.volumeId) {
          const volume = instance.volumeId[k];
          deleteIds.push(parseDeleteSnapshotIds(yield fetchSnapshotByDescription(`${instance.description}${volume}`), instance.generation));
        }
        const ids = _.flattenDeep(deleteIds);
        console.log('delete snapshot ids : ', ids);
        try {
          yield deleteSnapshot(ids);
        } catch (err) {
          // インスタンス単位で処理しているため、スナップショット削除のエラーは握りつぶす
          console.log(err);
        };
      }
    } catch (e) {
      console.log('error : ', e);
    };
    return callback(null, 'ebs backup done');
  });

};
