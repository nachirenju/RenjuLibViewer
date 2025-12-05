# RenjuLibViewer 

**RenjuLibViewer** is a lightweight, web-based application for viewing and editing Renju (Gomoku) library files (`.lib`). It runs on modern browsers and Android devices (via Capacitor).

**RenjuLibViewer** は、連珠（五目並べ）の定石ライブラリファイル（`.lib`形式）を閲覧・編集するための軽量アプリケーションです。ブラウザおよびAndroid端末で動作します。

## Features / 機能

* **View & Navigate**: Open `.lib` files and navigate through the game tree.
* **Edit**: Add comments, text markers, and new moves.
* **Branch Mode**: Hide move numbers to practice joseki.
* **Manage**: Save your changes to `.lib` files locally.
* **Share**: Share board images with comments via SNS.
* **Cross-Platform**: Built with Web technologies (Vite), runnable as an Android App.

* **閲覧・操作**: `.lib`ファイルを読み込み、分岐ツリーを探索できます。
* **編集**: コメントや盤上の文字（A, Bなど）、新しい着手の追加が可能です。
* **分岐**: 石番号を非表示にして分岐を入力できます（出題用に作りました）
* **保存**: 編集した内容を`.lib`ファイルとして保存できます。
* **共有**: 盤面画像を生成し、SNS等へシェアできます。
* **マルチプラットフォーム**: Web技術（Vite）で作られており、Androidアプリとしても動作します。

## Author / 製作者

**nachirenju**

I run a YouTube channel dedicated to Renju (Gomoku). Please subscribe!
連珠（五目並べ）関係のYouTubeチャンネルを運営しております。応援していただけると嬉しいです。

* 📺 **YouTube Channel**: [那智暴虐のれんじゅいし【競技五目並べ】](https://www.youtube.com/channel/UCfbgN9hrrh9fmFKs8gxln5g)

## Credits & License / クレジットとライセンス

This project is licensed under the **GNU General Public License v3.0 (GPLv3)**.

This application is based on **rapfi** developed by **dhbloo**.
Basic logic for parsing RenLib files and the tree structure concept are derived from their work.

本アプリケーションは、**dhbloo** 氏によって開発された **rapfi** をベースに作成されました。
RenLib形式のパース処理やツリー構造の基本ロジックにおいて、多大な影響とコードの参照を受けています。

* **Original Project**: [rapfi by dhbloo](https://github.com/dhbloo/rapfi)
* **License**: GPL v3.0

## Development / 開発

### Setup

```bash
# Install dependencies
npm install
