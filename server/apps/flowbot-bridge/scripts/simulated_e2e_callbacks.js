"use strict";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn8pWQAAAAASUVORK5CYII=",
  "base64",
);

function buildTextCallback({
  seq,
  id,
  sender,
  senderName,
  content,
  sendtime,
  atList = [],
  roomId = "room-sim-1",
  roomName = "模拟测试群",
}) {
  return {
    guid: "guid-sim-1",
    notify_type: 11010,
    data: {
      seq: String(seq),
      id,
      roomid: roomId,
      room_name: roomName,
      sender,
      sender_name: senderName,
      receiver: roomId,
      sendtime,
      msg_type: 2,
      content,
      at_list: atList,
      send_flag: 0,
    },
  };
}

function buildImageCallback({
  seq,
  id,
  sender,
  senderName,
  sendtime,
  title = "报错截图",
  desc = "登录页提示异常",
  roomId = "room-sim-1",
  roomName = "模拟测试群",
}) {
  return {
    guid: "guid-sim-1",
    notify_type: 11010,
    data: {
      seq: String(seq),
      id,
      roomid: roomId,
      room_name: roomName,
      sender,
      sender_name: senderName,
      receiver: roomId,
      sendtime,
      msg_type: 5,
      content: "",
      title,
      desc,
      file_name: "mock.png",
      send_flag: 0,
      cdn: {
        file_id: "mock-file-id",
        aes_key: "mock-aes-key",
        size: PNG_1X1.length,
        image_width: 1,
        image_height: 1,
        md5: "mock-image-md5",
      },
    },
  };
}

function buildVoiceCallback({
  seq,
  id,
  sender,
  senderName,
  sendtime,
  transcriptText = "支付成功了，但是订单页一直转圈，回不来。",
  transcriptStatus = "success",
  transcriptLanguage = "zh",
  transcriptDurationSeconds = 8,
  roomId = "room-sim-1",
  roomName = "模拟测试群",
}) {
  return {
    guid: "guid-sim-1",
    notify_type: 11010,
    data: {
      seq: String(seq),
      id,
      roomid: roomId,
      room_name: roomName,
      sender,
      sender_name: senderName,
      receiver: roomId,
      sendtime,
      msg_type: 6,
      content: "",
      file_name: "mock-audio.mp3",
      transcript_status: transcriptStatus,
      transcript_text: transcriptText,
      transcript_language: transcriptLanguage,
      transcript_duration_seconds: transcriptDurationSeconds,
      transcript_provider: "mock-asr",
      transcript_model: "mock-asr-v1",
      send_flag: 0,
    },
  };
}

module.exports = {
  PNG_1X1,
  buildImageCallback,
  buildTextCallback,
  buildVoiceCallback,
};
