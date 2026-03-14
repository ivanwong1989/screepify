const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

module.exports = function(grunt) {

    // Helper function to get current git branch
    function getCurrentBranch() {
        try {
            return execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
        } catch (e) {
            return 'unknown';
        }
    }

    function walkJsFiles(rootDir, out) {
        const entries = fs.readdirSync(rootDir, { withFileTypes: true });
        entries.forEach((entry) => {
            const fullPath = path.join(rootDir, entry.name);
            if (entry.isDirectory()) {
                walkJsFiles(fullPath, out);
                return;
            }
            if (entry.isFile() && entry.name.endsWith('.js')) {
                out.push(fullPath);
            }
        });
    }

    function toPosixPath(filePath) {
        return filePath.replace(/\\/g, '/');
    }

    function buildFlatModuleIdFromRelative(relativePath) {
        return relativePath.replace(/\.js$/, '').replace(/\//g, '_');
    }

    var config = require('./.screeps.json')
    var branch = grunt.option('branch') || config.branch;
    var email = grunt.option('email') || config.email;
    var password = grunt.option('password') || config.password;
    var token = grunt.option('token') || config.token;
    var ptr = grunt.option('ptr') ? true : config.ptr;
    var private_directory = 'C:/Users/ivanw/AppData/Local/Screeps/scripts/127_0_0_1___21025/default/';

    grunt.loadNpmTasks('grunt-screeps')
    grunt.loadNpmTasks('grunt-contrib-clean')
    grunt.loadNpmTasks('grunt-contrib-copy')

    grunt.initConfig({
        screeps: {
            options: {
                email: email
            },
            dist: {
                options: {
                    token: token,
                    branch: branch,
                    ptr: ptr
                },
                src: ['dist/*.js']
            },
            local: {
                options: {
                    server: {
                        host: '127.0.0.1',
                        port: 21025,
                        http: true
                    },
                    email: email,
                    password: password,
                    branch: 'default',
                    ptr: false
                },
                src: ['dist/*.js']
            }
        },

        // Remove all files from the dist folder.
        clean: {
          'dist': ['dist']
        },

        // Copy all source files into the dist folder, flattening the folder structure by converting path delimiters to underscores
        copy: {
          // Pushes the game code to the dist folder so it can be modified before being send to the screeps server.
          screeps: {
            files: [{
              expand: true,
              cwd: 'src/',
              src: '**',
              dest: 'dist/',
              filter: 'isFile',
              rename: function (dest, src) {
                // Change the path name utilize underscores for folders
                return dest + src.replace(/\//g,'_');
              }
            }],
          },
          private: {
            files: [{
              expand: true,
              cwd: 'src/',
              src: '**',
              dest: private_directory,
              filter: 'isFile',
              rename: function (dest, src) {
                // Change the path name utilize underscores for folders
                return dest + src.replace(/\//g,'_');
              }
            }],
          }
        },
    })


    // Custom Task: Check if on Master branch
    grunt.registerTask('check-master', function() {
        var currentBranch = getCurrentBranch();
        if (currentBranch !== 'master' && !currentBranch.startsWith('dev')) {
            grunt.fail.fatal('Safety Check: You are on "' + currentBranch + '". You must be on "master" to push to the main server!');
        }
        grunt.log.ok('Branch verified: master');
    });

    // Custom Task: Check if on Dev branch
    grunt.registerTask('check-dev', function() {
        var currentBranch = getCurrentBranch();
        if (currentBranch !== 'master' && !currentBranch.startsWith('dev')) {
            grunt.fail.fatal('Safety Check: You are on "' + currentBranch + '". You must be on "dev" to push to private server!');
        }
        grunt.log.ok('Branch verified: dev');
    });

    grunt.registerTask('validate-flat-modules', function() {
        const srcRoot = path.resolve('src');
        if (!fs.existsSync(srcRoot)) {
            grunt.fail.fatal('validate-flat-modules: src/ does not exist.');
            return;
        }

        const jsFiles = [];
        walkJsFiles(srcRoot, jsFiles);

        const flatNameToSource = new Map();
        const moduleIds = new Set();
        const violations = [];

        jsFiles.forEach((absPath) => {
            const rel = toPosixPath(path.relative(srcRoot, absPath));
            const flatJs = rel.replace(/\//g, '_');
            const moduleId = buildFlatModuleIdFromRelative(rel);

            moduleIds.add(moduleId);
            if (flatNameToSource.has(flatJs)) {
                violations.push(
                    'Flatten collision: "' + rel + '" and "' + flatNameToSource.get(flatJs) + '" both map to "' + flatJs + '".'
                );
            } else {
                flatNameToSource.set(flatJs, rel);
            }
        });

        const requirePattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
        jsFiles.forEach((absPath) => {
            const rel = toPosixPath(path.relative(srcRoot, absPath));
            const content = fs.readFileSync(absPath, 'utf8');
            let match;
            while ((match = requirePattern.exec(content)) !== null) {
                const spec = match[1];
                if (spec.startsWith('.') || spec.includes('/') || spec.includes('\\')) {
                    violations.push(
                        rel + ': invalid require("' + spec + '"). Use flat module ids like require("empire_index").'
                    );
                    continue;
                }
                if (spec.includes('_') && !moduleIds.has(spec)) {
                    violations.push(
                        rel + ': require("' + spec + '") has no matching src module after flattening.'
                    );
                }
            }
        });

        if (violations.length > 0) {
            violations.forEach((v) => grunt.log.error(v));
            grunt.fail.fatal('Flat module validation failed with ' + violations.length + ' issue(s).');
            return;
        }

        grunt.log.ok('Flat module validation passed for ' + jsFiles.length + ' file(s).');
    });

    grunt.registerTask('default',  ['check-master', 'validate-flat-modules', 'clean', 'copy:screeps', 'screeps:dist']);
    grunt.registerTask('local',    ['check-dev', 'validate-flat-modules', 'clean', 'copy:screeps', 'screeps:local']);
    grunt.registerTask('private',  ['check-dev', 'validate-flat-modules', 'clean', 'copy:screeps', 'copy:private']);

}
