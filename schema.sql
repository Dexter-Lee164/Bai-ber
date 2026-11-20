CREATE DATABASE IF NOT EXISTS bai_ber CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE bai_ber;

CREATE TABLE IF NOT EXISTS users (
  user_id INT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(24) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  legacy_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS friendships (
  friendship_id INT PRIMARY KEY AUTO_INCREMENT,
  sender_id INT NOT NULL,
  receiver_id INT NOT NULL,
  status ENUM('pending','accepted','declined','cancelled') NOT NULL DEFAULT 'pending',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  active_low INT GENERATED ALWAYS AS (IF(status IN ('pending','accepted'), LEAST(sender_id,receiver_id), NULL)) VIRTUAL,
  active_high INT GENERATED ALWAYS AS (IF(status IN ('pending','accepted'), GREATEST(sender_id,receiver_id), NULL)) VIRTUAL,
  UNIQUE KEY active_pair (active_low, active_high),
  FOREIGN KEY (sender_id) REFERENCES users(user_id),
  FOREIGN KEY (receiver_id) REFERENCES users(user_id),
  CHECK (sender_id <> receiver_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS messages (
  message_id INT PRIMARY KEY AUTO_INCREMENT,
  sender_id INT NOT NULL,
  receiver_id INT NOT NULL,
  content TEXT NOT NULL,
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  edited_at DATETIME NULL,
  deleted_at DATETIME NULL,
  INDEX conversation (sender_id,receiver_id,message_id),
  INDEX received (receiver_id,sender_id,message_id),
  FOREIGN KEY (sender_id) REFERENCES users(user_id),
  FOREIGN KEY (receiver_id) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS conversation_reads (
  user_id INT NOT NULL,
  peer_id INT NOT NULL,
  last_read_id INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id,peer_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (peer_id) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sessions (
  sid VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  sess TEXT NOT NULL,
  expires BIGINT NOT NULL,
  user_id INT NULL,
  INDEX (expires), INDEX (user_id)
) ENGINE=InnoDB;
