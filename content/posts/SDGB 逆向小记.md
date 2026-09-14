# Some reverse log about SDGB 1.55

先说结论。SDGB 的登录不是一个请求就完事，完整流程大概是这样：

```text
二维码 -> Aime Server -> userId + token
       -> GetUserPreviewApi
       -> UserLoginApi -> JSESSIONID
       -> 一堆 GetUser*Api
       -> UpsertUserAllApi / UpsertUserChargelogApi
       -> UserLogoutApi
```

# Aime Login

二维码不是直接拿去给 Title Server 的。Ichino 这里先 POST 到配置里的 `aimeUrl`。

二维码如果超过 64 个字符，只取最后 64 个。前面的东西可以丢。

```dart
qrCode = qrCodeToken.length > 64
    ? qrCodeToken.substring(qrCodeToken.length - 64)
    : qrCodeToken;
```

然后生成 timestamp。是 Tokyo time，格式为 `yymmddhhmmss`，不是 Unix timestamp。

```text
timestamp = yyMMDDHHmmss
key = SHA256(chipId + timestamp + aimeSalt).toUpperCase()
```

实际 JSON：

```json
{
  "chipID": "...",
  "openGameID": "MAID",
  "key": "SHA256_RESULT",
  "qrCode": "最后 64 位二维码内容",
  "timestamp": "250101123456"
}
```

Header 里有：

```text
Content-Type: application/json
User-Agent: WC_AIME_LIB
```

返回值主要看这几个：

```json
{
  "errorID": 0,
  "userID": 123456,
  "token": "..."
}
```

`errorID == 0` 才算成功。后面 Preview 和 UserLogin 都要带这个 `userID + token`。

# Title Server 包装

Title Server 的 body 不是明文 JSON。这里最容易看错。

先根据 API 名字算 URL：

```text
hash = MD5(apiName + "MaimaiChn" + obfuscateParam)
POST titleServerUrl + "/" + hash
```

body 的处理顺序：

```text
JSON
 -> UTF-8
 -> zlib compress
 -> AES-CBC + PKCS7 padding
 -> POST
```

响应反过来：

```text
AES decrypt
 -> zlib decompress
 -> UTF-8 JSON
```

请求 Header 基本固定：

```text
User-Agent: {hash}#{userId}
Content-Type: application/json
Mai-Encoding: {apiVersion}
Accept-Encoding:
Charset: UTF-8
Content-Encoding: deflate
number: 0
```

如果还拿到了 `JSESSIONID`，再加：

```text
Cookie: JSESSIONID=...
```

额，`Content-Encoding: deflate` 看起来和上面的 AES body 对不上。但 Ichino 就是这么发的。不要自作聪明改成 gzip，server 不一定理你。

`User-Agent` 这里也不是随便写。普通请求是 `{hash}#{userId}`，如果 userId 是 0 才用 `clientId` 当后缀。

# Preview

在登录的时候，机器会调用 `GetUserPreviewApi`。

packet：

```json
{
  "userId": 123456,
  "segaIdAuthKey": "",
  "token": "AIME_LOGIN_TOKEN",
  "clientId": "..."
}
```

这个接口返回的就是上机前那个确认界面需要的信息：昵称、rating、头像、称号、最后登录时间之类的。重点字段：

```text
isLogin
banState
errorId
```

`isLogin == true` 的时候说明这个号已经有人登录了。机器不会继续走完整登录，通常就是 15min 小黑屋。

所以流程不是“Preview 成功就 Login”。要先看 `isLogin`。

二维码在有效期内可以重复使用，但前提是没有刷新新的二维码。刷新了新的，旧的基本就废了。

# Login

接着机器发送 `UserLoginApi` 到 Title Server。

packet 是下面这样：

```json
{
  "userId": 123456,
  "accessCode": "",
  "regionId": 0,
  "placeId": 0,
  "clientId": "...",
  "dateTime": 1700000000,
  "loginDateTime": 1700000600,
  "isContinue": false,
  "genericFlag": 0,
  "token": "AIME_LOGIN_TOKEN"
}
```

这里的 `dateTime` 是 `now - 600`，`loginDateTime` 是当前 Unix timestamp，单位秒。

返回值看 `returnCode`：

```text
returnCode == 1 -> login 成功
```

成功之后会拿到：

```text
loginId
lastLoginDate
token
```

同时，Title Server 的 response header 里会下发 `Set-Cookie`。只截取里面的 `JSESSIONID`，后面所有大部分请求都带这个 Cookie。

这里有两个 token，别混了：

- Aime 返回的 `token`：放进 `GetUserPreviewApi` / `UserLoginApi` 的 JSON。
- Title Server 返回的 `JSESSIONID`：放进 HTTP `Cookie` header。

事实上，Ichino 后面的 GetData 请求没有再把 Aime token 到处塞，而是主要依赖这个 `JSESSIONID`。

# GetData

`GetData` 不是一个 API。额这个名字容易误导。

Ichino 的 `fetchUserAllData` 实际上并发调用下面 7 个接口，packet 都只有一个 `userId`：

```json
{
  "userId": 123456
}
```

接口和返回字段大概是：

```text
GetUserDataApi          -> userData + banState
GetUserExtendApi        -> userExtend
GetUserOptionApi        -> userOption
GetUserRatingApi        -> userRating
GetUserChargeApi        -> userChargeList
GetUserActivityApi      -> userActivity
GetUserMissionDataApi   -> userMissionDataList + userWeeklyData
```

首页只需要 `GetUserDataApi` 就能显示基本信息。

但是后面要发 `UpsertUserAllApi`，这 7 个基本都得拉。少一个不是简单地补 `{}` 就完事，很多时候 server 会直接静默丢掉整包。很烦。

另外还有一个单独的 `GetUserCharacterApi`，返回 `userCharacterList`。当前 UserAll builder 没把它混进普通的 7 个请求里。

# 发票

这里原来写的 `targetUserId`、`UserChargeLogData` 更像 Java model 的写法。实际 wire packet 不是那样。

真正发的是 `UpsertUserChargelogApi`：

```json
{
  "userId": 123456,
  "userChargelog": {
    "chargeId": 12345,
    "price": 0,
    "purchaseDate": "2025-01-01 12:34:56.0",
    "playCount": 0,
    "playerRating": 12345,
    "placeId": 0,
    "regionId": 0,
    "clientId": "..."
  },
  "userCharge": {
    "chargeId": 12345,
    "stock": 1,
    "purchaseDate": "2025-01-01 12:34:56.0",
    "validDate": "2025-04-01 04:00:00"
  },
  "loginDateTime": 1700000600
}
```

注意字段名是 `userChargelog`，中间那个 `l` 是小写。

`purchaseDate` 用 `yyyy-MM-dd HH:mm:ss.0`。 `validDate` 是当天凌晨 4 点再加 90 天，格式没有最后的 `.0`。

当前 app 还会先检查这张票的 `stock`。已经有库存就不继续发票，省得重复写一坨奇怪的数据。

# UpsertUserAll

这个才是最容易炸的地方。

Ichino 的做法是先拉上面那 7 份数据，然后以它们为基础拼一个 UserAll。外层结构：

```json
{
  "userId": 123456,
  "playlogId": 987654,
  "isEventMode": false,
  "isFreePlay": false,
  "loginDateTime": 1700000600,
  "userPlaylogList": [
    "一条 userPlaylog"
  ],
  "upsertUserAll": {
    "...": "见下面"
  }
}
```

## userData 不能原样塞回去

从 `GetUserDataApi` 拿到的 `userData` 要先 copy 一份，然后删掉：

```text
friendCode
nameplateId
trophyId
cmLastEmoneyBrand
cmLastEmoneyCredit
```

这些字段放进 `UpsertUserAllApi.userData` 里，Lionheart 可能直接静默丢整包。不是返回一个好看的 error 给你，什么都不说，挺阴间。

然后覆盖 / 更新：

```text
accessCode = ""
isNetMember = 1
playCount = 原 playCount + 1
currentPlayCount = 原 currentPlayCount + 1
lastGameId = "SDGB"
lastLoginDate = loginDateTime 格式化后的时间
lastPlayDate = 当前上海时间
lastPlayCredit = 1
lastPlayMode = 0
lastPlaceId = config.placeId
lastPlaceName = config.placeName
lastAllNetId = 0
lastRegionId = config.regionId
lastRegionName = config.regionName
lastClientId = config.clientId
lastCountryCode = "CHN"
banState = GetUserDataApi 的 banState
dateTime = loginDateTime
```

时间格式是 `yyyy-MM-dd HH:mm:ss.0`。

## 其他数据也要清洗

不是只有 `userData` 有坑。

`userOption` 要删掉：

```text
tempoVolume
```

`userRating.udemae` 里的大写重复字段也要删：

```text
MaxLoseNum
NpcLoseNum
NpcMaxLoseNum
NpcMaxWinNum
NpcTotalLoseNum
NpcTotalWinNum
NpcWinNum
```

`userChargeList` 不要原样带回去，只保留 4 个字段：

```text
chargeId
stock
purchaseDate
validDate
```

`userMissionDataList` 只取前 6 条，每条只保留：

```text
type
difficulty
targetGenreId
targetGenreTableId
conditionGenreId
conditionGenreTableId
clearFlag
```

`userWeeklyData` 只保留：

```text
lastLoginWeek
beforeLoginWeek
friendBonusFlag
```

## upsertUserAll 的主体

builder 最后拼出来的主体大概是这样：

```text
userData: [newUserData]
userExtend: [userExtend]
userOption: [newUserOption]
userCharacterList: []
userGhost: []
userMapList: []
userLoginBonusList: []
userRatingList: [userRating]
userItemList: []                 // 后面按功能 patch
userMusicDetailList: [musicData]
userCourseList: []
userFriendSeasonRankingList: []
userChargeList: 清洗后的列表
userFavoriteList: []
userActivityList: [userActivity]
userMissionDataList: missions
userWeeklyData: weekly
userGamePlaylogList: [一条记录]
user2pPlaylog: 空的双人记录
userIntimateList: []
userShopItemStockList: []
userGetPointList: []
userTradeItemList: []
userFavoritemusicList: []
userKaleidxScopeList: []
```

后面还有一堆 `isNew*List` 标志。普通情况下大部分是空字符串，`isNewMusicDetailList` 默认是 `"0"`，有歌曲数据更新时改成 `"1"`。

## musicData

Ichino 里默认构造的 `musicData` 很小：

```json
{
  "musicId": 11538,
  "level": 0,
  "playCount": 1,
  "achievement": 0,
  "comboStatus": 0,
  "syncStatus": 0,
  "deluxscoreMax": 0,
  "scoreRank": 0,
  "extNum1": 0
}
```

解锁歌曲时，`musicId` 换成输入的 ID。这个对象会放进：

```text
upsertUserAll.userMusicDetailList = [musicData]
isNewMusicDetailList = "1"
```

然后在 `userItemList` 里塞解锁道具：

```json
{
  "itemKind": 5,
  "itemId": 834,
  "stock": 1,
  "isValid": true
}
```

`itemKind`：

```text
5 = 歌曲
6 = Master
7 = Re:Master
```

三个可以一起发。 `isNewItemList` 按 item 数量生成对应的 `1` 字符串，比如三个就是 `"111"`。

收藏品也是同一条 UserAll，只是 itemKind 换成 1/2/3/10/11/12。packet：

```json
{
  "itemKind": 3,
  "itemId": 250103,
  "stock": 1,
  "isValid": true
}
```

## userPlaylog

每次 UserAll 里会附带一条假的 playlog。不是只发一个 `musicId`，字段很多。

重点字段如下：

```text
userId = 0
orderId = 0
playlogId = loginId
version = convertVersionNumber(lastRomVersion)
placeId = config.placeId
placeName = config.placeName
loginDate = loginDateTime
playDate = yyyy-MM-dd
userPlayDate = yyyy-MM-dd HH:mm:ss.0
type = 0
musicId = musicData.musicId
level = musicData.level
trackNo = 1
playerNum = 1
achievement = musicData.achievement
deluxscore = musicData.deluxscoreMax
scoreRank = musicData.scoreRank
```

`version` 有个转换：

```text
1.56.00 -> 1056000
```

算法就是 `major * 1000000 + minor * 1000 + patch`。版本解析失败时 fallback 到 `1053000`。

判定相关的默认值也写死了：

```text
tapMiss = 1
totalCombo = 1
maxCombo = 0
maxSync = 1
isTap = true
isHold = false
isSlide = false
isTouch = false
isBreak = false
isClear = achievement >= 500000
```

其他 note 判定基本都是 0。 `beforeRating` / `afterRating` 都直接用当前 `playerRating`，所以这条假 playlog 本身没有做 rating 计算。

角色槽位会补到 5 个：没有的填 0，每个角色的 level 是 1，awakening 是 0。

另外，`userGamePlaylogList` 里还有一条 session 级别记录：

```text
playlogId = loginId
version = 原始 lastRomVersion 字符串
playDate = 当前时间
playMode = 0
useTicketId = -1
playCredit = 1
playTrack = 1
clientId = config.clientId
playCount = 0
playSpecial = calcRandom()
playOtherUserId = 0
```

这里的 `playSpecial` 不是随便写 0。Ichino 生成一个随机数，再做 32 位 bit reverse。server 如果突然抽风，先看这个字段。

## 发包功能

最后调用：

```text
UpsertUserAllApi
```

返回有 `returnCode` 的话要检查是不是 `1`。有些 fire-and-forget API 会不返回 `returnCode`，这种情况 Ichino 会当作成功；只有字段存在且不是 1 才报错。

源码里还实现了 `UploadUserPlaylogApi`，但当前歌曲解锁和收藏品 workflow 走的不是它，实际走的是 `UpsertUserAllApi`。

# Logout

退出登录调用 `UserLogoutApi`：

```json
{
  "userId": 123456,
  "accessCode": "",
  "regionId": 0,
  "placeId": 0,
  "clientId": "...",
  "loginDateTime": 1700000600,
  "type": 1
}
```

`type = 1` 就是普通 Logout。

Ichino 的 UI 在 login 之后会冷却 60 秒才允许使用功能票、解锁歌曲或发收藏品。上传完成后如果勾了自动退出，还会等 5 秒再发 Logout。这个是 app 行为，不是协议硬要求，但不等的话有些环境确实容易出毛病。

# the past

在 1.53 更新之前，`GetUserPreviewApi` 可以直接调用，不需要携带任何 Token，唯一需要的参数就是 `userId`。所以可以脚本批量扫号。

同时 Login 也只需要一个 `userId`。但需要在 30min 以内有一个可用的二维码被刷新出来。

1.53 之后，Wa1eak 给 Preview 加了 Token 校验，需要传 `token + userId` 才能调；`UserLoginApi` 也变成需要 `token + userId`。

另外 UserLogin 会在 Title Server response header 回传 `JSESSIONID`，后面的 GetData / Upsert 基本靠这个 Cookie。这个和 Aime 返回的 token 不是一回事。

所以现在再拿旧脚本直接扫，额，就是寄。
