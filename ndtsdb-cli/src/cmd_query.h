// cmd_query.h - Query 子命令声明
#ifndef CMD_QUERY_H
#define CMD_QUERY_H

// 6个查询子命令
int cmd_query(int argc, char *argv[]);
int cmd_list(int argc, char *argv[]);
int cmd_tail(int argc, char *argv[]);
int cmd_head(int argc, char *argv[]);
int cmd_count(int argc, char *argv[]);
int cmd_info(int argc, char *argv[]);

#endif
