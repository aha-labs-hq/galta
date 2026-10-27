// The OS owns this lock. Closing stdin (including parent death) releases it.
// Kept native so installing a hardened app never needs executable-memory FFI.
#include <sys/file.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
#include <errno.h>

int main(int argc, char **argv) {
    if (argc != 2) return 64;
    int fd = open(argv[1], O_RDWR | O_CREAT | O_NOFOLLOW, 0600);
    if (fd < 0) { perror("Cannot open installation lock"); return 1; }
    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        fputs("Another Galta installation is in progress. Try again when it finishes.\n", stderr);
        close(fd); return 1;
    }
    if (write(STDOUT_FILENO, "1", 1) != 1) { close(fd); return 1; }
    char byte;
    while (read(STDIN_FILENO, &byte, 1) > 0 || errno == EINTR) { errno = 0; }
    close(fd);
    return 0;
}
