/*
 * Extract files from a Warcraft III map (.w3x) using StormLib.
 * Compile: cc -o extract_mpq extract_mpq.c -I/opt/homebrew/include -L/opt/homebrew/lib -lstorm
 * Usage:   ./extract_mpq <input.w3x> <output_dir>
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <errno.h>
#include <StormLib.h>

int main(int argc, char *argv[]) {
    if (argc < 3) {
        fprintf(stderr, "Usage: %s <input.w3x> <output_dir>\n", argv[0]);
        return 1;
    }

    const char *input = argv[1];
    const char *outdir = argv[2];

    // Open the MPQ archive
    HANDLE mpq;
    DWORD flags = MPQ_OPEN_READ_ONLY;
    if (!SFileOpenArchive(input, 0, flags, &mpq)) {
        fprintf(stderr, "Failed to open %s (error %u)\n", input, SErrGetLastError());
        return 1;
    }

    // Create output directory
    mkdir(outdir, 0755);

    // Search all files
    SFILE_FIND_DATA findData;
    HANDLE findHandle = SFileFindFirstFile(mpq, "*", &findData, NULL);
    if (findHandle == NULL) {
        DWORD err = SErrGetLastError();
        if (err == ERROR_NO_MORE_FILES) {
            fprintf(stderr, "Archive is empty or no listfile found.\n");
        } else {
            fprintf(stderr, "Find failed (error %u). Trying with listfile hint...\n", err);
        }
        // Try with explicit listfile
        findHandle = SFileFindFirstFile(mpq, "*", &findData, "(listfile)");
        if (findHandle == NULL) {
            fprintf(stderr, "Still failed (error %u)\n", SErrGetLastError());
            SFileCloseArchive(mpq);
            return 1;
        }
    }

    int count = 0;
    do {
        const char *name = findData.cFileName;

        // Skip (listfile) and (attributes) pseudo-files
        if (name[0] == '(') continue;
        
        // Skip directories (name ending with backslash or empty)
        size_t len = strlen(name);
        if (len == 0 || name[len - 1] == '\\') continue;

        // Build output path
        char outpath[1024];
        snprintf(outpath, sizeof(outpath), "%s/%s", outdir, name);

        // Create subdirectories as needed
        char *p = outpath + strlen(outdir) + 1;
        while (*p) {
            if (*p == '\\' || *p == '/') {
                *p = '\0';
                mkdir(outpath, 0755);
                *p = '/';
            }
            p++;
        }

        // Open file in archive
        HANDLE fileHandle;
        if (!SFileOpenFileEx(mpq, name, 0, &fileHandle)) {
            fprintf(stderr, "Failed to open %s (error %u)\n", name, SErrGetLastError());
            continue;
        }

        DWORD size = SFileGetFileSize(fileHandle, NULL);
        if (size == SFILE_INVALID_SIZE || size == 0) {
            SFileCloseFile(fileHandle);
            continue;
        }

        void *buffer = malloc(size);
        if (!buffer) {
            fprintf(stderr, "Out of memory for %s (%u bytes)\n", name, size);
            SFileCloseFile(fileHandle);
            continue;
        }

        DWORD bytesRead;
        if (!SFileReadFile(fileHandle, buffer, size, &bytesRead, NULL)) {
            fprintf(stderr, "Failed to read %s (error %u)\n", name, SErrGetLastError());
            free(buffer);
            SFileCloseFile(fileHandle);
            continue;
        }

        // Write to disk
        FILE *fout = fopen(outpath, "wb");
        if (fout) {
            fwrite(buffer, 1, size, fout);
            fclose(fout);
            printf("%8u  %s\n", size, name);
            count++;
        } else {
            fprintf(stderr, "Failed to write %s: %s\n", outpath, strerror(errno));
        }

        free(buffer);
        SFileCloseFile(fileHandle);
    } while (SFileFindNextFile(findHandle, &findData));

    SFileFindClose(findHandle);
    SFileCloseArchive(mpq);

    printf("\nExtracted %d files to %s/\n", count, outdir);
    return 0;
}
