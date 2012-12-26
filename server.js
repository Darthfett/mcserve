#!/usr/bin/env node

var spawn = require('child_process').spawn
  , readline = require('readline')
  , http = require('http')
  , Batch = require('batch')
  , util = require('util')
  , crypto = require('crypto')
  , zfill = require('zfill')
  , moment = require('moment')
  , packageJson = require('./package.json')

var env = {
  PORT: process.env.PORT || 9999,
  HOST: process.env.HOST || '0.0.0.0',
};

var GRAY_COLOR = "#808080";
var SERVER_JAR_PATH = 'minecraft_server.jar';

var onliners = {};
var messages = [];
var restartRequested = false;
var mcServer = null;
var httpServer = null;

var lineHandlers = [
  {
    re: new RegExp(/^(\d+\-\d+\-\d+ \d+\:\d+\:\d+) \[INFO\] (.+) \[\/(\d+\.\d+.\d+.\d+:\d+)\] logged in with entity id (\d+?) at \(.+?\)$/),
    fn: function(match) {
      date = match[1];
      name = match[2];
      onUserJoined(name);
      console.info(name, "logged in");
    },
  },
  {
    re: new RegExp(/^(\d+\-\d+\-\d+ \d+\:\d+\:\d+) \[INFO\] (.+?) lost connection: (.+)$/),
    fn: function(match) {
      date = match[1];
      name = match[2];
      onUserLeft(name);
      console.info(name, "logged out");
    },
  },
  {
    re: new RegExp(/^(\d+\-\d+\-\d+ \d+\:\d+\:\d+) \[WARNING\] (.+?) was kicked for (.+?)$/),
    fn: function(match) {
      date = match[1];
      name = match[2];
      why = match[3];
      onUserLeft(name);
      console.info(name, "kicked for", why);
    },
  },
  {
    re: new RegExp(/^(\d+\-\d+\-\d+ \d+\:\d+\:\d+) \[INFO\] (.+?)\: Kicking (.+?)$/),
    fn: function(match) {
      date = match[1];
      kicker = match[2];
      name = match[3];
      onUserLeft(name);
      console.info(name, "kicked by", kicker);
    },
  },
  {
    re: new RegExp(/^(\d+\-\d+\-\d+ \d+\:\d+\:\d+) \[INFO\] <(.+?)> (.+)$/),
    fn: function(match) {
      date = match[1];
      name = match[2];
      msg = match[3];
      addMessage(new ChatMessage(name, msg));
    },
  },
  {
    re: new RegExp(/^(\d+\-\d+\-\d+ \d+\:\d+\:\d+) \[INFO\] (.+?) issued server command\: (.+)$/),
    fn: function(match) {
      name = match[2];
      cmd = match[3];
      tryCmd(name, cmd, true);
    },
  },
  {
    re: new RegExp(/^(\d+\-\d+\-\d+ \d+\:\d+\:\d+) \[INFO\] (.+?) tried command\: (.+)$/),
    fn: function(match) {
      name = match[2];
      cmd = match[3];
      tryCmd(name, cmd, false);
    },
  },
];

var cmdHandlers = {
  restart: function(name, op) {
    if (restartRequested) {
      mcPut("tell " + name + " restart is already requested");
    } else {
      mcPut("say " + name + " has requested a server restart once everyone logs off");
      addMessage(new ServerRestartRequestMessage(name));
      restartRequested = true;
    }
  },
};

main();

function htmlFilter(text, color) {
  text = text.replace(/&/g, '&amp;');
  text = text.replace(/"/g, '&quot;');
  text = text.replace(/</g, '&lt;');
  text = text.replace(/>/g, '&gt;');
  if (color) text = "<span style=\"color:" + color + "\">" + text + "</span>";
  return text;
}

function dateHeaderHtml(date) {
  return htmlFilter(moment(date).format("YYYY-MM-DD HH:mm:ss"), GRAY_COLOR);
}

function colorFromName(name) {
  var nameHash = parseInt(crypto.createHash('md5').update(name).digest('hex'), 16);
  var color = nameHash & 0xa0a0a0;
  return "#" + zfill(color.toString(16), 6);
}

function startServer() {
  httpServer = http.createServer(function(req, resp) {
    console.info("got GET request");
    resp.statusCode = 200;
    resp.setEncoding('utf8');
    resp.write(
      "<!doctype html>" +
      "<html>" +
      "<head>" +
      "<title>MineCraft Server Status</title>" +
      "</head>" +
      "<body>"
    );
    var onliner, joinDate;
    if (serverEmpty()) {
      resp.write("<p>Nobody is online :-(</p>");
    } else {
      resp.write("<h2>Online players:</h2><ul>");
      for (onliner in onliners) {
        joinDate = onliners[onliner];
        resp.write("<li>" + htmlFilter(onliner, colorFromName(onliner)) + ", joined " + moment(joinDate).fromNow() + "</li>");
      }
      resp.write("</ul>");
    }
    resp.write("<h2>latest gibberish</h2>");
    var i, msg;
    for (i = messages.length - 1; i >= 0; --i) {
      msg = messages[i];
      resp.write(msg.html());
    }
    resp.write("<p><a href=\"https://github.com/superjoe30/mcserve\">mcserve</a> version " + packageJson.version + "</p></body></html>");
    resp.end();
  });
  httpServer.listen(function() {
    console.info("Listening at http://" + env.HOST + ":" + env.PORT);
  });
}

function startReadingInput() {
  var rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on('line', function(line) {
    rl.prompt();
  });
  rl.on('close', function() {
    mcServer.removeListener('exit', restartMcServer);
    httpServer.close();
    rl.close();
    mcPut("stop");
  });
  rl.on('SIGINT', function() {
    // TODO
  });
  rl.setPrompt("MC> ");
  rl.prompt();
}

function restartMcServer() {
  addMessage(new ServerRestartMessage());
  onliners = {};
  restartRequested = false;
}

function startMcServer() {
  mcServer = spawn('java', ['-Xmx1024M', '-Xms1024M', '-jar', SERVER_JAR_PATH, 'nogui'], {
    stdio: 'pipe',
  });
  mcServer.stdin.setEncoding('utf8');
  var buffer = "";
  mcServer.stdout.setEncoding('utf8');
  mcServer.stdout.on('data', function(data) {
    buffer += data;
    var lines = buffer.split("\n");
    var len = lines.length - 1;
    for (var i = 0; i < len; ++i) {
      onMcLine(lines[i]);
    }
    buffer = lines[lines.length - 1];
  });
  mcServer.stderr.setEncoding('utf8');
  mcServer.stderr.on('data', function(data) {
    process.stderr.write(data);
  });
  mcServer.on('exit', restartMcServer);
}

function addMessage(msg) {
  messages.push(msg);
  while (messages.length > 100) {
    messages.shift();
  }
}

function onUserJoined(name) {
  onliners[name] = new Date();
  addMessage(new JoinLeftMessage(name, true));
}

function serverEmpty() {
  for (var onliner in onliners) {
    return false;
  }
  return true;
}

function mcPut(cmd) {
  console.info("[in]", cmd);
  mcServer.stdin.write(cmd + "\n");
}


function tryCmd(name, cmd, op) {
  op = op == null ? false : op;
  console.info("try cmd '" + name + "' '" + cmd + "'");
  fn = cmdHandlers[cmd];
  if (fn) {
    fn(name, op);
  } else {
    console.info("no such command:", cmd);
  }
}

function onUserLeft(name) {
  delete onliners[name];
  addMessage(new JoinLeftMessage(name, false));
  checkRestart();
}

function checkRestart() {
  if (restartRequested && serverEmpty()) {
    mcPut("stop");
    // TODO: if minecraft takes longer than 5 seconds to restart, kill it
  }
}


function onMcLine(line) {
  console.info("[out]", line);
  var handler, match;
  for (var i = 0; i < lineHandlers.length; ++i) {
    handler = lineHandlers[0];
    match = line.match(handler.re);
    if (match) {
      handler.fn(match);
      return;
    }
  }
  console.info("Unrecognized mc line:", line);
}

function main() {
  startServer();
  startReadingInput();
  startMcServer();
}

function Message() {
  this.date = new Date();
}

Message.prototype.html = function() {
  return dateHeaderHtml(this.date) + " " + this.htmlContent();
}

function ChatMessage(name, msg) {
  Message.call(this);
  this.name = name
  this.msg = msg
}
util.inherits(ChatMessage, Message);

ChatMessage.prototype.htmlContent = function() {
  return "&lt;" + htmlFilter(this.name, colorFromName(this.name)) + "&gt; " + htmlFilter(this.msg);
}

function JoinLeftMessage(name, joined) {
  Message.call(this);
  joined = joined == null ? true : joined;
  this.name = name;
  this.joined = joined;
  this.timestamp = new Date();
  if (joined) this.isQuickReturn = false;
  this._whatHappenedHtml = joined ? "joined" : "left";
  // try to find the most recent join/left activity from this person to give more info
  var i, otherMsg, howLongItsBeen;
  for (i = messages.length - 1; i >= 0; --i) {
    otherMsg = messages[i];
    if (! (otherMsg.isJoinMessage && otherMsg.name === name && otherMsg.joined !== joined)) continue;
    howLongItsBeen = this.timestamp - otherMsg.timestamp;
    if (joined) {
      if (howLongItsBeen < 60000) {
        // time spent logged out was too short to count.
        // patch the logout message to indicate it was quick.
        otherMsg._whatHappenedHtml = htmlFilter("logged out briefly", GRAY_COLOR);
        this._whatHappenedHtml = htmlFilter("logged back in", GRAY_COLOR);
        this.isQuickReturn = true;
      } else {
        this._whatHappenedHtml += htmlFilter(" (logged off for " + moment.duration(howLongItsBeen).humanize() + ")", GRAY_COLOR);
      }
      break;
    } else {
      if (otherMsg.isQuickReturn) {
        // skip quick logouts
        continue;
      }
      this._whatHappenedHtml += htmlFilter(" (logged on for " + moment.duration(howLongItsBeen).humanize() + ")", GRAY_COLOR);
      break;
    }
  }
}
util.inherits(JoinLeftMessage, Message);

JoinLeftMessage.prototype.htmlContent = function() {
  return "*" + htmlFilter(this.name, colorFromName(this.name)) + " " + this._whatHappenedHtml;
};

function ServerRestartRequestMessage(name) {
  Message.call(this);
  this.name = name;
}

util.inherits(ServerRestartRequestMessage, Message);

ServerRestartRequestMessage.prototype.htmlContent = function() {
  return "*" + htmlFilter(this.name, colorFromName(this.name)) + " requested restart";
};

function ServerRestartMessage() {
  Message.call(this);
}
util.inherits(ServerRestartMessage, Message);

ServerRestartMessage.prototype.htmlContent = function() {
  return "server restart";
};
