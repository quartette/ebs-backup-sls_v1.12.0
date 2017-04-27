
「Backup-Generation」タグがついたインスタンスのEBSバックアップを取得します。

過去に作ったものがnodejs v0.10だったのでv6.10で動くのもにしました
https://github.com/quartette/ebs-backup

## アーキテクチャ
* Serverless Framework v1.12.0
* nodejs > v6.10

## Installation

```
% npm -g install serverless
% git clone https://github.com/quartette/ebs-backup-sls_v1.120.git
% cd ebs-backup-sls_v1.120
% npm install
% sls deploy -s dev -v
```

## ローカル実行

```
% sls invoke local -f ebsBackup --stage dev -v
```

※ デフォルトでDryRunをtrueにしてあるので実際にスナップショットを作成する際はfalseにしてください。
